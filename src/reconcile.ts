// Reconciliation checker: 10-item consistency scan
import { TaskProperties, ProjectProperties, RecordProperties, ReconciliationFinding } from './types.js';

export function reconcile(
  tasks: TaskProperties[],
  projects: ProjectProperties[],
  records: RecordProperties[]
): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];

  // 1. Isolated Tasks (no project link)
  for (const task of tasks) {
    if (['DONE', 'CLOSED', 'KILLED'].includes(task['状态'])) continue;
    if (!task['所属项目'] || task['所属项目'].length === 0) {
      findings.push({
        type: 'isolated_task',
        severity: 'warning',
        record_id: task['Task ID'],
        description: `Task ${task['Task ID']} has no project link`,
        suggestion: 'Link task to a project or mark as standalone',
      });
    }
  }

  // 2. One Task - Multiple Projects
  for (const task of tasks) {
    if (task['所属项目'] && task['所属项目'].length > 1) {
      findings.push({
        type: 'multi_project_task',
        severity: 'warning',
        record_id: task['Task ID'],
        description: `Task ${task['Task ID']} linked to ${task['所属项目'].length} projects`,
        suggestion: 'Keep only one project link per task',
      });
    }
  }

  // 3. Runs without Tasks
  const taskIds = new Set(tasks.map(t => t['Task ID']));
  for (const record of records) {
    if (record['记录类型'] === 'Run' && !taskIds.has(record['Task ID'])) {
      findings.push({
        type: 'orphan_run',
        severity: 'error',
        record_id: record.id,
        description: `Run record ${record.id} references non-existent Task ${record['Task ID']}`,
        suggestion: 'Delete orphan run or restore task link',
      });
    }
  }

  // 4. Duplicate Run IDs
  const runKeys = new Map<string, string[]>();
  for (const record of records) {
    if (record['记录类型'] !== 'Run') continue;
    const key = `${record['Task ID']}::${record['Run ID']}::${record['记录类型']}`;
    if (!runKeys.has(key)) runKeys.set(key, []);
    runKeys.get(key)!.push(record.id);
  }
  for (const [key, ids] of runKeys) {
    if (ids.length > 1) {
      findings.push({
        type: 'duplicate_run',
        severity: 'error',
        record_id: ids.join(', '),
        description: `Duplicate run key: ${key} (${ids.length} records)`,
        suggestion: 'Keep only the latest run record',
      });
    }
  }

  // 5. RUNNING without Session/Start Time/Heartbeat
  for (const task of tasks) {
    if (task['状态'] !== 'RUNNING') continue;
    const issues: string[] = [];
    if (!task['执行会话']) issues.push('no session');
    if (!task['开始时间']) issues.push('no start time');
    if (!task['上次心跳']) issues.push('no heartbeat');
    if (issues.length > 0) {
      findings.push({
        type: 'running_incomplete',
        severity: 'error',
        record_id: task['Task ID'],
        description: `RUNNING task ${task['Task ID']} missing: ${issues.join(', ')}`,
        suggestion: 'Set session, start time, and heartbeat for running tasks',
      });
    }
  }

  // 6. Multiple Current Deliverables
  const deliverableTypes = new Map<string, string[]>();
  for (const record of records) {
    if (record['记录类型'] !== 'Deliverable') continue;
    const key = `${record['Task ID']}::${record['Gate序号']}`;
    if (!deliverableTypes.has(key)) deliverableTypes.set(key, []);
    deliverableTypes.get(key)!.push(record.id);
  }
  for (const [key, ids] of deliverableTypes) {
    if (ids.length > 1) {
      findings.push({
        type: 'multiple_current_deliverables',
        severity: 'error',
        record_id: ids.join(', '),
        description: `Multiple current deliverables for ${key}`,
        suggestion: 'Mark only one as Current',
      });
    }
  }

  // 7. CLOSED with failed Gates
  for (const task of tasks) {
    if (task['状态'] !== 'CLOSED') continue;
    const failedGates = records.filter(
      r => r['Task ID'] === task['Task ID'] && r['Gate状态'] === 'FAIL'
    );
    if (failedGates.length > 0) {
      findings.push({
        type: 'closed_with_failed_gates',
        severity: 'error',
        record_id: task['Task ID'],
        description: `Task ${task['Task ID']} is CLOSED but has ${failedGates.length} failed gate(s)`,
        suggestion: 'Resolve failed gates before closing',
      });
    }
  }

  // 8. Review gate passed but missing manual acceptance
  //    'QC2' is an illustrative record-type name — replace it with your own review gate label.
  for (const task of tasks) {
    if (task['状态'] !== 'DONE') continue;
    const qc2Records = records.filter(
      r => r['Task ID'] === task['Task ID'] && r['记录类型'] === 'QC2' && r['Gate状态'] === 'PASS'
    );
    if (qc2Records.length > 0 && task['结果'] !== 'PASS') {
      findings.push({
        type: 'qc2_no_acceptance',
        severity: 'warning',
        record_id: task['Task ID'],
        description: `Task ${task['Task ID']} QC2 passed but no manual acceptance`,
        suggestion: 'Set result to PASS or add acceptance record',
      });
    }
  }

  // 9. Baseline drift
  for (const task of tasks) {
    if (['DONE', 'CLOSED', 'KILLED'].includes(task['状态'])) continue;
    if (task['需求Hash'] && task['需求版本']) {
      // Check if current properties differ from baseline hash
      // This is a simplified check - real implementation would recompute hash
      if (task['需求版本'] > 1 && !task['变更摘要']) {
        findings.push({
          type: 'baseline_drift',
          severity: 'warning',
          record_id: task['Task ID'],
          description: `Task ${task['Task ID']} has version ${task['需求版本']} but no change summary`,
          suggestion: 'Add change summary for baseline drift',
        });
      }
    }
  }

  // 10. Unsummarized Model Events
  for (const record of records) {
    if (record['记录类型'] !== 'Model Event') continue;
    if (!record['证据摘要']) {
      findings.push({
        type: 'unsummarized_model_event',
        severity: 'info',
        record_id: record.id,
        description: `Model event ${record.id} missing evidence summary`,
        suggestion: 'Add evidence summary for model events',
      });
    }
  }

  // === v4: 可视化编号体系校验 ===

  // 11. 空号检查：纳入流程但序号为空
  for (const record of records) {
    if (!record['纳入流程']) continue;
    if (!record['序号'] || record['序号'] === '' || record['序号'] === 0) {
      findings.push({
        type: 'v4_empty_sequence',
        severity: 'warning',
        record_id: record.id,
        description: `Record ${record['记录显示名'] || record.id} 纳入流程但序号为空`,
        suggestion: '为该记录分配序号或取消纳入流程',
      });
    }
  }

  // 12. 重号检查：同一项目内序号重复
  const projectRecords = new Map<string, RecordProperties[]>();
  for (const record of records) {
    if (!record['纳入流程']) continue;
    // 优先用 Records 直接关联的所属项目；无则走 Task→Project 间接路径
    let projectIds = record['所属项目'] || [];
    if (projectIds.length === 0) {
      const linkedTask = tasks.find(t => t['Task ID'] === record['Task ID']);
      if (linkedTask?.['所属项目']) projectIds = linkedTask['所属项目'];
    }
    if (projectIds.length === 0) continue;
    for (const projectId of projectIds) {
      if (!projectRecords.has(projectId)) projectRecords.set(projectId, []);
      projectRecords.get(projectId)!.push(record);
    }
  }
  for (const [projectId, recs] of projectRecords) {
    const seqMap = new Map<number, string[]>();
    for (const rec of recs) {
      const seq = Number(rec['序号']);
      if (!seqMap.has(seq)) seqMap.set(seq, []);
      seqMap.get(seq)!.push(rec.id);
    }
    for (const [seq, ids] of seqMap) {
      if (ids.length > 1) {
        findings.push({
          type: 'v4_duplicate_sequence',
          severity: 'error',
          record_id: ids.join(', '),
          description: `项目 ${projectId} 内序号 ${seq} 重复 (${ids.length} 条记录)`,
          suggestion: '检查并修正重复序号',
        });
      }
    }
  }

  // 13. 越界检查：序号 > 总步骤数
  for (const [projectId, recs] of projectRecords) {
    const project = projects.find(p => p.id === projectId);
    if (!project || !project['计划步骤总数']) continue;
    const totalSteps = project['计划步骤总数'];
    for (const rec of recs) {
      const seq = Number(rec['序号']);
      if (seq > totalSteps) {
        findings.push({
          type: 'v4_sequence_overflow',
          severity: 'error',
          record_id: rec.id,
          description: `记录 ${rec['记录显示名'] || rec.id} 序号 ${seq} 超出项目计划步骤总数 ${totalSteps}`,
          suggestion: '修正序号或更新项目计划步骤总数',
        });
      }
    }
  }

  // 14. 数量不一致：纳入流程记录数 ≠ 计划步骤总数
  for (const [projectId, recs] of projectRecords) {
    const project = projects.find(p => p.id === projectId);
    if (!project || !project['计划步骤总数']) continue;
    if (recs.length !== project['计划步骤总数']) {
      findings.push({
        type: 'v4_count_mismatch',
        severity: 'warning',
        record_id: projectId,
        description: `项目 ${project['项目名称']} 纳入流程记录 ${recs.length} 条 ≠ 计划步骤总数 ${project['计划步骤总数']}`,
        suggestion: '核对计划步骤总数或检查遗漏/多余记录',
      });
    }
  }

  // === v5: Gate 标题格式校验 ===

  // 15. 标题格式校验：Gate n/总数｜业务名称
  for (const record of records) {
    if (!record['纳入流程']) continue;
    const title = record['记录名称'];
    if (!title) continue;

    // 检查标题是否符合 Gate n/总数｜ 格式
    const gateTitleRegex = /^Gate\s+\d+[A-Za-z]?\/\d+\s*｜/;
    if (!gateTitleRegex.test(title)) {
      findings.push({
        type: 'v5_title_format',
        severity: 'warning',
        record_id: record.id,
        description: `记录 ${title} 标题不符合 Gate n/总数｜ 格式`,
        suggestion: 'Cron 将在下一轮自动修正标题前缀',
      });
    }

    // 检查分母与项目计划步骤总数是否一致
    const match = title.match(/^Gate\s+\d+[A-Za-z]?\/(\d+)/);
    if (match) {
      const titleTotal = parseInt(match[1], 10);
      const projectIds = record['所属项目'] || [];
      for (const pid of projectIds) {
        const project = projects.find(p => p.id === pid);
        if (project && project['计划步骤总数'] && titleTotal !== project['计划步骤总数']) {
          findings.push({
            type: 'v5_denominator_drift',
            severity: 'error',
            record_id: record.id,
            description: `记录 ${title} 标题分母 ${titleTotal} ≠ 项目计划步骤总数 ${project['计划步骤总数']}`,
            suggestion: 'Cron 将在下一轮自动修正分母',
          });
        }
      }
    }
  }

  return findings;
}

export function summarizeFindings(findings: ReconciliationFinding[]): {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  byType: Record<string, number>;
} {
  const byType: Record<string, number> = {};
  for (const f of findings) {
    byType[f.type] = (byType[f.type] || 0) + 1;
  }
  return {
    total: findings.length,
    errors: findings.filter(f => f.severity === 'error').length,
    warnings: findings.filter(f => f.severity === 'warning').length,
    infos: findings.filter(f => f.severity === 'info').length,
    byType,
  };
}
