// Main controller: 9-step deterministic pipeline
import { loadConfig } from './config.js';
import { getNotionClient, initNotionConfig, queryTasks, queryAllTasks, queryProjects, queryRecords, updateTask, updateProject, updateRecordTitle, createRecord } from './notion.js';
import { checkContractBatch, checkContractCompleteness, taskIdentifier, checkManualDecision, checkScheduledTime } from './contract.js';
import { routeDraftTask, canTransition, computeGateStatus, computeProjectProgress, computeProjectPhase, computeHealthStatus, computeGateTitle } from './state.js';
import { reconcile, summarizeFindings } from './reconcile.js';
import { computeTaskHash, buildRunIdempotencyKey, computeBaselineHash } from './idempotency.js';
import { createLogger } from './logger.js';
import { RunContext, ExitCode, TaskProperties, ProjectProperties, RecordProperties, isTerminalStatus } from './types.js';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, '..', 'state');
const LOCK_FILE = resolve(STATE_DIR, 'lock.json');
const CURSOR_FILE = resolve(STATE_DIR, 'cursor.json');

// --- CLI args ---

interface CliArgs {
  dryRun: boolean;
  execute: boolean;
  once: boolean;
  reconcile: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  return {
    dryRun: !args.includes('--execute'),
    execute: args.includes('--execute'),
    once: args.includes('--once'),
    reconcile: args.includes('--reconcile'),
  };
}

// --- Lock management ---

async function acquireLock(ctx: RunContext): Promise<boolean> {
  try {
    if (existsSync(LOCK_FILE)) {
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      const age = Date.now() - new Date(lock.timestamp).getTime();
      if (age < 5 * 60 * 1000) { // 5 min TTL
        console.log(`[LOCK] SKIPPED_LOCKED: ${lock.runId} (${Math.round(age / 1000)}s ago)`);
        process.exit(ExitCode.LOCKED);
        return false;
      }
    }
    // Lock payload deliberately holds no hostname / user / path info: it is only
    // used to detect a live second instance, run id + pid is sufficient.
    writeFileSync(LOCK_FILE, JSON.stringify({
      runId: ctx.runId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    }));
    return true;
  } catch (e) {
    console.error('[LOCK] Failed to acquire lock:', e);
    process.exit(ExitCode.ERROR);
    return false;
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf-8'));
      // 只释放属于本 Run 的锁；同步删除，避免 process.exit 前异步删除未完成
      if (lock.runId === ctx.runId) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // silent
  }
}

// --- Cursor management ---

function loadCursor(): string {
  try {
    if (existsSync(CURSOR_FILE)) {
      const cursor = JSON.parse(readFileSync(CURSOR_FILE, 'utf-8'));
      return cursor.lastTaskId || '';
    }
  } catch {
    // silent
  }
  return '';
}

function saveCursor(taskId: string) {
  try {
    writeFileSync(CURSOR_FILE, JSON.stringify({
      lastTaskId: taskId,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // silent
  }
}

// --- Step pipeline ---

let ctx: RunContext;

async function step1_ReadConfig() {
  const config = loadConfig();
  initNotionConfig(config);
  ctx.dryRun = parseArgs().dryRun;
  ctx.once = parseArgs().once;
  ctx.reconcile = parseArgs().reconcile;
  logger.info('Step 1: Config loaded', { dryRun: ctx.dryRun, once: ctx.once, reconcile: ctx.reconcile });
  return config;
}

async function step2_AcquireLock() {
  await acquireLock(ctx);
  logger.info('Step 2: Lock acquired');
}

async function step3_CursorRead() {
  ctx.cursor = loadCursor();
  logger.info('Step 3: Cursor loaded', { cursor: ctx.cursor });
}

async function step4_QueryAndNormalize() {
  const client = getNotionClient(config);
  const allTasks = await queryAllTasks(client);
  const projects = await queryProjects(client);
  const records = await queryRecords(client);
  logger.info('Step 4: Data loaded', {
    tasks: allTasks.length,
    projects: projects.length,
    records: records.length,
  });
  return { allTasks, projects, records };
}

async function step5_ContractValidation(allTasks: TaskProperties[]) {
  const draftTasks = allTasks.filter(t => t['状态'] === 'DRAFT');
  const results = checkContractBatch(draftTasks, allTasks);

  const passCount = Array.from(results.values()).filter(r => r.ok).length;
  const failCount = results.size - passCount;
  logger.info('Step 5: Contract validation', {
    total: results.size,
    pass: passCount,
    fail: failCount,
  });

  for (const [identifier, result] of results) {
    if (!result.ok) {
      logger.warn(`Contract failed for ${identifier}`, { errors: result.errors });
    }
  }

  return { results, draftTasks };
}

async function step6_WriteUpdates(
  allTasks: TaskProperties[],
  draftTasks: TaskProperties[],
  results: Map<string, any>,
  projects: ProjectProperties[],
  records: RecordProperties[]
) {
  const client = getNotionClient(config);
  let updated = 0;
  let skipped = 0;

  // Route DRAFT tasks
  for (const task of draftTasks) {
    const contractResult = results.get(task['Task ID']);
    if (!contractResult || !contractResult.ok) {
      skipped++;
      continue;
    }

    const { target, reason } = routeDraftTask(task, allTasks);
    if (!target) {
      logger.debug(`Skip ${task['Task ID']}: ${reason}`);
      skipped++;
      continue;
    }

    if (!canTransition(task['状态'] as any, target)) {
      logger.warn(`Invalid transition: ${task['状态']} → ${target} for ${task['Task ID']}`);
      skipped++;
      continue;
    }

    const preHash = computeTaskHash(task);

    if (ctx.dryRun) {
      logger.info(`[DRY RUN] Would update ${task['Task ID']}: ${task['状态']} → ${target}`, { reason, preHash });
      updated++;
      continue;
    }

    const updates: any = {
      '状态': target,
      '版本号': (task['版本号'] || 1) + 1,
      // 不再写库中不存在的 Pre-Hash
      '当前里程碑': reason,
    };

    // Compute gate status
    updates['执行可观测Gate'] = computeGateStatus(task);

    const success = await updateTask(client, task.id, updates, ctx);
    if (success) {
      // 不再写库中不存在的 Post-Hash（旧版会触发空 properties 二次调用）
      updated++;
      logger.info(`Updated ${task['Task ID']}: ${task['状态']} → ${target}`);
    } else {
      skipped++;
    }
  }

  // Sync project progress
  for (const project of projects) {
    const projectTasks = allTasks.filter(t =>
      t['所属项目'] && t['所属项目'].includes(project.id)
    );
    const progress = computeProjectProgress(projectTasks);
    const phase = computeProjectPhase(projectTasks);
    const health = computeHealthStatus(projectTasks);

    if (progress !== project['进度'] || phase !== project['阶段']) {
      if (ctx.dryRun) {
        logger.info(`[DRY RUN] Would update project ${project['Project ID']}: progress ${project['进度']}→${progress}, phase ${project['阶段']}→${phase}`);
      } else {
        await updateProject(client, project.id, {
          '进度': progress,
          '阶段': phase,
          '健康度': health,
          '版本号': (project['版本号'] || 1) + 1,
        } as any, ctx);
        logger.info(`Updated project ${project['Project ID']}: progress=${progress}, phase=${phase}`);
      }
    }
  }

  // v5: Sync Gate record titles (Gate n/总数｜业务名称)
  let titleUpdated = 0;
  for (const record of records) {
    if (!record['纳入流程']) continue;
    const seq = Number(record['序号']);
    if (!seq) continue;

    // Get project total steps
    const projectIds = record['所属项目'] || [];
    let totalSteps = 0;
    for (const pid of projectIds) {
      const proj = projects.find(p => p.id === pid);
      if (proj && proj['计划步骤总数']) {
        totalSteps = proj['计划步骤总数'];
        break;
      }
    }
    if (!totalSteps) continue;

    const newTitle = computeGateTitle(seq, totalSteps, record['记录名称']);
    if (!newTitle) continue; // 输入不完整，跳过

    if (newTitle !== record['记录名称']) {
      if (ctx.dryRun) {
        logger.info(`[DRY RUN] Would update record title: "${record['记录名称']}" → "${newTitle}"`);
        titleUpdated++;
      } else {
        const success = await updateRecordTitle(client, record.id, newTitle, ctx);
        if (success) {
          titleUpdated++;
          logger.info(`Updated record title: "${record['记录名称']}" → "${newTitle}"`);
        }
      }
    }
  }

  logger.info('Step 6: Writes complete', { updated, skipped, titleUpdated });
  return { updated, skipped };
}

async function step7_Verify() {
  // Re-query to verify writes landed
  const client = getNotionClient(config);
  const allTasks = await queryAllTasks(client);
  logger.info('Step 7: Verification complete', { tasks: allTasks.length });
  return allTasks;
}

async function step8_Assert(verifiedTasks: TaskProperties[]) {
  // Assert no tasks in invalid states
  const invalid = verifiedTasks.filter(t => {
    if (t['状态'] === 'RUNNING' && !t['执行会话']) return true;
    if (t['状态'] === 'RUNNING' && !t['开始时间']) return true;
    return false;
  });

  // 保护 WAITING_FOR_NOTION_AI 任务不被自动覆盖
  // 检测执行方/预检元数据漂移（Notion AI 评审会话可能误覆盖）
  const waitingForAI = verifiedTasks.filter(t => t['状态'] === 'WAITING_FOR_NOTION_AI');
  for (const t of waitingForAI) {
    if (t['执行方'] && t['执行方'] !== 'Primary' && t['执行方'] !== 'Notion AI') {
      logger.warn('Step 8: WAITING_FOR_NOTION_AI task executor drift detected', {
        taskId: t['Task ID'],
        executor: t['执行方'],
        expected: 'Primary or Notion AI',
      });
    }
    if (t['领取前预检'] === 'NOT RUN') {
      logger.warn('Step 8: WAITING_FOR_NOTION_AI task pre-check reset detected', {
        taskId: t['Task ID'],
        preCheck: t['领取前预检'],
      });
    }
  }

  if (invalid.length > 0) {
    logger.warn('Step 8: Assertions found issues', {
      count: invalid.length,
      tasks: invalid.map(t => t['Task ID']),
    });
  } else {
    logger.info('Step 8: All assertions passed');
  }
}

async function step9_Reconcile(allTasks: TaskProperties[], projects: ProjectProperties[], records: RecordProperties[]) {
  if (!ctx.reconcile) {
    logger.info('Step 9: Reconciliation skipped (use --reconcile)');
    return;
  }

  const findings = reconcile(allTasks, projects, records);
  const summary = summarizeFindings(findings);

  logger.info('Step 9: Reconciliation complete', summary);

  for (const f of findings) {
    if (f.severity === 'error') {
      logger.error(`[${f.type}] ${f.description}`, { record_id: f.record_id });
    } else if (f.severity === 'warning') {
      logger.warn(`[${f.type}] ${f.description}`, { record_id: f.record_id });
    } else {
      logger.info(`[${f.type}] ${f.description}`, { record_id: f.record_id });
    }
  }

  // Write reconciliation report
  const reportPath = resolve(__dirname, '..', 'logs', `reconcile-${new Date().toISOString().slice(0, 10)}.json`);
  try {
    writeFileSync(reportPath, JSON.stringify({ summary, findings }, null, 2));
  } catch {
    // silent
  }
}

// --- 唯一 Dispatcher 领取入口（WAITING_FOR_PRIMARY → RUNNING，CAS + 幂等 + 终态保护） ---

function selectClaimCandidates(allTasks: TaskProperties[]): TaskProperties[] {
  return allTasks
    .filter(t => t['状态'] === 'WAITING_FOR_PRIMARY')
    .filter(t => t['执行方'] === 'Primary')
    .filter(t => !isTerminalStatus(t['状态']))
    .filter(t => !!t['Task ID'] && String(t['Task ID']).trim() !== '')
    // 幂等：已有 Run ID 的任务不得重复创建第二个 Run
    .filter(t => !t['Run ID'] || String(t['Run ID']).trim() === '')
    .filter(t => !checkManualDecision(t))
    .filter(t => checkScheduledTime(t))
    .filter(t => checkContractCompleteness(t).ok)
    .sort((a, b) => {
      const ga = Number(a['Gate序号']) || 999;
      const gb = Number(b['Gate序号']) || 999;
      if (ga !== gb) return ga - gb;
      return String(a['优先级'] || '').localeCompare(String(b['优先级'] || ''));
    });
}

async function step6b_ClaimWaitingForPrimary(allTasks: TaskProperties[]) {
  const candidates = selectClaimCandidates(allTasks);
  logger.info('Step 6b: claim scan', { candidates: candidates.length });
  if (candidates.length === 0) return { claimed: 0 };

  // 每轮最多领取 1 项（禁止批量领取）
  const task = candidates[0];
  const expectedVersion = task['版本号'] || 1;
  const client = getNotionClient(config);

  // CAS：写入前回读，确认仍为 WAITING_FOR_PRIMARY 且版本号未变
  const reread = await queryAllTasks(client);
  const current = reread.find(t => t.id === task.id);
  if (!current || current['状态'] !== 'WAITING_FOR_PRIMARY' || (current['版本号'] || 1) !== expectedVersion) {
    logger.warn('Step 6b: CAS failed, claim skipped', {
      taskId: task['Task ID'],
      currentStatus: current ? current['状态'] : 'MISSING',
      expectedVersion,
      currentVersion: current ? current['版本号'] : null,
    });
    return { claimed: 0, casFailed: true };
  }

  const nowIso = new Date().toISOString();
  const claimRunId = task['Task ID'] + '-PRIMARY-' + nowIso.replace(/[-:T]/g, '').slice(0, 14);
  const leaseIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  // Run 四要素必须同一次写入：Run ID / 执行会话 / 开始时间 / 租约（+ 首心跳）
  const updates: any = {
    '状态': 'RUNNING',
    'Run ID': claimRunId,
    '执行会话': 'http://127.0.0.1:3080/?session=dispatcher&run=' + encodeURIComponent(claimRunId),
    '开始时间': nowIso,
    '上次心跳': nowIso,
    '租约到期': leaseIso,
    '当前里程碑': 'Dispatcher 已领取；等待执行方首心跳与 Checkpoint',
    '进度': 5,
    '版本号': expectedVersion + 1,
  };

  if (ctx.dryRun) {
    logger.info('[DRY RUN] Would claim WAITING_FOR_PRIMARY', { taskId: task['Task ID'], claimRunId });
    return { claimed: 0, dryRun: true };
  }

  const ok = await updateTask(client, task.id, updates, ctx);
  if (ok) {
    logger.info('Step 6b: claimed', { taskId: task['Task ID'], runId: claimRunId, version: expectedVersion + 1 });
    return { claimed: 1, runId: claimRunId };
  }
  logger.warn('Step 6b: claim write failed', { taskId: task['Task ID'] });
  return { claimed: 0, writeFailed: true };
}

// --- Supervisor（只读）——RUNNING 任务的会话/心跳/租约/Checkpoint ---

async function runSupervise(): Promise<number> {
  const client = getNotionClient(config);
  const tasks = await queryAllTasks(client);
  const running = tasks.filter(t => t['状态'] === 'RUNNING');
  const now = Date.now();
  const findings = running.map(t => {
    const missing: string[] = [];
    if (!t['执行会话']) missing.push('执行会话');
    if (!t['开始时间']) missing.push('开始时间');
    if (!t['上次心跳']) missing.push('上次心跳');
    if (!t['租约到期']) missing.push('租约到期');
    if (!t['当前里程碑']) missing.push('当前里程碑/Checkpoint');
    const leaseTs = t['租约到期'] ? Date.parse(t['租约到期']) : NaN;
    const leaseExpired = !isNaN(leaseTs) && leaseTs < now;
    const heartbeatTs = t['上次心跳'] ? Date.parse(t['上次心跳']) : NaN;
    const heartbeatAgeMin = isNaN(heartbeatTs) ? null : Math.round((now - heartbeatTs) / 60000);
    const status = (missing.length > 0 || leaseExpired) ? 'BLOCKED' : 'OK';
    return { taskId: t['Task ID'], status, missing, leaseExpired, heartbeatAgeMin, heartbeat: t['上次心跳'], lease: t['租约到期'] };
  });
  const blocked = findings.filter(f => f.status !== 'OK');
  const result = blocked.length > 0 ? 'BLOCKED' : 'OK';
  process.stdout.write(JSON.stringify({
    supervisor: 'AR11B-v1',
    checkedAt: new Date().toISOString(),
    runningCount: running.length,
    result,
    findings,
  }) + '\n');
  logger.info('Supervisor run', { runningCount: running.length, blocked: blocked.length, result });
  return blocked.length > 0 ? ExitCode.ERROR : ExitCode.OK;
}

// --- Main ---

let config: any;
let logger: any;

async function main() {
  ctx = {
    runId: `RUN-${Date.now().toString(36).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    dryRun: true,
    once: false,
    reconcile: false,
    cursor: '',
  };

  logger = createLogger();

  // Supervisor 只读模式（不领取、不写业务结论）
  if (process.argv.includes('--supervise')) {
    try {
      await step1_ReadConfig();
      const code = await runSupervise();
      process.exit(code);
    } catch (e) {
      logger.error('Supervisor failed', { error: String(e) });
      process.exit(ExitCode.ERROR);
    }
  }

  logger.info('=== Controller v3 start ===', { runId: ctx.runId });

  try {
    config = await step1_ReadConfig();
    await step2_AcquireLock();
    await step3_CursorRead();

    const { allTasks, projects, records } = await step4_QueryAndNormalize();
    const { results, draftTasks } = await step5_ContractValidation(allTasks);
    await step6_WriteUpdates(allTasks, draftTasks, results, projects, records);
    await step6b_ClaimWaitingForPrimary(allTasks);

    if (!ctx.dryRun) {
      const verified = await step7_Verify();
      await step8_Assert(verified);
    }

    await step9_Reconcile(allTasks, projects, records);

    logger.info('=== Controller v3 complete ===', { runId: ctx.runId });
    releaseLock();
    process.exit(ExitCode.OK);
  } catch (e) {
    logger.error('Controller failed', { error: String(e) });
    releaseLock();
    process.exit(ExitCode.ERROR);
  }
}

main();
