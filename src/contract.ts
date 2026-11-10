// Pure contract validation functions (no side effects)
import { TaskProperties, ContractCheckResult } from './types.js';

export function taskIdentifier(task: TaskProperties): string {
  const taskId = task['Task ID'];
  if (taskId && String(taskId).trim() !== '') {
    return String(taskId).trim();
  }
  if (task.id && String(task.id).trim() !== '') {
    return String(task.id).trim();
  }
  const name = task['任务名称'];
  if (name && String(name).trim() !== '') {
    return String(name).trim();
  }
  return 'unnamed';
}

const REQUIRED_FIELDS = [
  '任务名称',
  'Task ID',
  'Gate序号',
  '优先级',
  '状态',
  '执行方',
];

// 与任务库实际 select 选项对齐（旧值 'P2 中' 导致合法任务被判契约失败）
const VALID_PRIORITIES = ['P0 紧急', 'P1 高', 'P2 普通', 'P3 低', 'P2 中'];
// 执行方与状态选项必须与任务库实际 select 选项一致
const VALID_EXECUTORS = ['Worker A', 'Worker B', 'Notion AI', 'Primary'];
const VALID_STATUSES = [
  'DRAFT', 'WAITING_FOR_PRIMARY', 'WAITING_FOR_WORKER_A', 'WAITING_FOR_WORKER_B',
  'WAITING_FOR_NOTION_AI', 'RUNNING', 'NEEDS_USER', 'DONE', 'CLOSED', 'KILLED', 'ERROR'
];

export function checkContractCompleteness(task: TaskProperties): ContractCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Required fields
  for (const field of REQUIRED_FIELDS) {
    const value = task[field as keyof TaskProperties];
    // 0 是合法值（Gate序号=0），只有 null/undefined/空串才算缺失
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // 2. Priority valid
  if (task['优先级'] && !VALID_PRIORITIES.includes(task['优先级'])) {
    errors.push(`Invalid priority: ${task['优先级']}`);
  }

  // 3. Executor valid
  if (task['执行方'] && !VALID_EXECUTORS.includes(task['执行方'])) {
    errors.push(`Invalid executor: ${task['执行方']}`);
  }

  // 4. Status valid
  if (task['状态'] && !VALID_STATUSES.includes(task['状态'])) {
    errors.push(`Invalid status: ${task['状态']}`);
  }

  // 5. Task ID format (should contain hyphen)
  if (task['Task ID'] && !task['Task ID'].includes('-')) {
    warnings.push(`Task ID may not follow convention: ${task['Task ID']}`);
  }

  // 6. Gate number should be positive
  if (task['Gate序号'] && typeof task['Gate序号'] === 'number' && task['Gate序号'] <= 0) {
    errors.push(`Gate number must be positive: ${task['Gate序号']}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function checkPrerequisites(
  task: TaskProperties,
  allTasks: TaskProperties[]
): [boolean, string] {
  const prereq = task['前置任务'];
  if (!prereq || prereq.trim() === '') {
    return [true, 'No prerequisites'];
  }

  const prereqTask = allTasks.find(t => t['Task ID'] === prereq);
  if (!prereqTask) {
    return [false, `Prerequisite task not found: ${prereq}`];
  }

  const doneStatuses = ['DONE', 'CLOSED'];
  if (!doneStatuses.includes(prereqTask['状态'])) {
    return [false, `Prerequisite ${prereq} is ${prereqTask['状态']}, not DONE/CLOSED`];
  }

  return [true, `Prerequisite ${prereq} is ${prereqTask['状态']}`];
}

// checkbox 属性按 boolean 判定（兼容历史字符串值）
export function truthyCheckbox(v: any): boolean {
  return v === true || v === 'true' || v === '__YES__';
}

export function checkManualDecision(task: TaskProperties): boolean {
  return truthyCheckbox(task['人工判断点']);
}

export function checkScheduledTime(task: TaskProperties): boolean {
  if (!task['计划时间'] || task['计划时间'].trim() === '') {
    return true;
  }
  const planTime = new Date(task['计划时间']);
  return planTime <= new Date();
}

export function checkDuplicateTaskId(
  task: TaskProperties,
  allTasks: TaskProperties[]
): [boolean, string] {
  const duplicates = allTasks.filter(
    t => t['Task ID'] === task['Task ID'] && t.id !== task.id && !['DONE', 'CLOSED', 'KILLED'].includes(t['状态'])
  );
  if (duplicates.length > 0) {
    return [false, `Duplicate Task ID in active tasks: ${task['Task ID']}`];
  }
  return [true, 'Task ID is unique'];
}

export function checkMaxRetries(task: TaskProperties): [boolean, string] {
  const maxRetries = task['最大自动重试'] || 2;
  const currentRetries = task['重试次数'] || 0;
  if (currentRetries >= maxRetries) {
    return [false, `Max retries reached: ${currentRetries}/${maxRetries}`];
  }
  return [true, `Retries: ${currentRetries}/${maxRetries}`];
}

export function checkAutoCloseAllowed(task: TaskProperties): boolean {
  return truthyCheckbox(task['允许自动关闭']);
}

export function checkExternalCoderAllowed(task: TaskProperties): boolean {
  return truthyCheckbox(task['允许调用外部编码代理']);
}

export function checkAutoDispatch(task: TaskProperties): boolean {
  return truthyCheckbox(task['自动派活']);
}

export function checkDataLevelSafe(task: TaskProperties): boolean {
  return task['数据等级'] !== 'P3 高敏';
}

export function checkContractBatch(
  tasks: TaskProperties[],
  allTasks: TaskProperties[]
): Map<string, ContractCheckResult> {
  const results = new Map<string, ContractCheckResult>();
  const keyCounts = new Map<string, number>();

  for (const task of tasks) {
    const { ok, errors, warnings } = checkContractCompleteness(task);
    const [prereqOk, prereqMsg] = checkPrerequisites(task, allTasks);
    const [dupOk, dupMsg] = checkDuplicateTaskId(task, allTasks);
    const [retryOk, retryMsg] = checkMaxRetries(task);

    if (!prereqOk) errors.push(prereqMsg);
    if (!dupOk) errors.push(dupMsg);
    if (!retryOk) errors.push(retryMsg);
    if (checkManualDecision(task)) errors.push('Manual decision point set');
    if (!checkScheduledTime(task)) errors.push('Scheduled time not reached');

    const baseKey = taskIdentifier(task);
    const count = keyCounts.get(baseKey) || 0;
    const key = count === 0 ? baseKey : `${baseKey}#${count + 1}`;
    keyCounts.set(baseKey, count + 1);

    results.set(key, {
      ok: errors.length === 0,
      errors,
      warnings,
    });
  }

  return results;
}
