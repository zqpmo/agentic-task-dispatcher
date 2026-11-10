// Idempotency: hash computation, version lock, unique key
import stableStringify from 'fast-json-stable-stringify';
import { createHash } from 'crypto';
import { TaskProperties, ProjectProperties, RecordProperties } from './types.js';

function stableStr(obj: any): string {
  return stableStringify(obj);
}

// --- Deterministic hash of task/project properties ---

export function computeHash(obj: any): string {
  const canonical = stableStr(obj);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function computeTaskHash(task: TaskProperties): string {
  const subset = {
    name: task['任务名称'],
    taskId: task['Task ID'],
    gate: task['Gate序号'],
    priority: task['优先级'],
    executor: task['执行方'],
    status: task['状态'],
  };
  return computeHash(subset);
}

export function computeProjectHash(project: ProjectProperties): string {
  const subset = {
    name: project['项目名称'],
    projectId: project['Project ID'],
    status: project['状态'],
    phase: project['阶段'],
    progress: project['进度'],
  };
  return computeHash(subset);
}

// --- Idempotency key for Run records ---

export function buildRunIdempotencyKey(taskId: string, runId: string, recordType: string): string {
  return `${taskId}::${runId}::${recordType}`;
}

// --- Version lock (optimistic) ---

export function checkVersionLock(current: number, expected: number): boolean {
  return current === expected;
}

export function incrementVersion(version: number): number {
  return version + 1;
}

// --- Baseline snapshot hash ---

export function computeBaselineHash(task: TaskProperties): string {
  const baseline = {
    taskId: task['Task ID'],
    gate: task['Gate序号'],
    priority: task['优先级'],
    executor: task['执行方'],
    executionMode: task['执行模式'],
    taskType: task['任务类型'],
    taskDomain: task['任务域'],
    dataLevel: task['数据等级'],
    prerequisite: task['前置任务'],
    planTime: task['计划时间'],
  };
  return computeHash(baseline);
}

// --- Pre/Post hash for audit trail ---

export function buildPreHash(task: TaskProperties): string {
  return computeTaskHash(task);
}

export function buildPostHash(task: TaskProperties): string {
  return computeTaskHash(task);
}

// --- Unique deliverable check ---

export function isCurrentDeliverableUnique(
  records: RecordProperties[],
  taskId: string,
  recordType: string,
  candidateId: string
): boolean {
  const currentRecords = records.filter(
    r => r['Task ID'] === taskId && r['记录类型'] === recordType
  );
  const duplicates = currentRecords.filter(r => r.id !== candidateId);
  return duplicates.length === 0;
}
