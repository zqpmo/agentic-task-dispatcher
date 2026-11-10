// State machine: valid transitions, gate checks, status routing
import { TaskProperties, TaskStatus, VALID_TRANSITIONS, ContractCheckResult } from './types.js';
import {
  checkContractCompleteness,
  checkPrerequisites,
  checkManualDecision,
  checkScheduledTime,
  checkDuplicateTaskId,
  checkMaxRetries,
} from './contract.js';

// --- Transition validation ---

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function getValidTransitions(from: TaskStatus): TaskStatus[] {
  return VALID_TRANSITIONS[from] || [];
}

// --- Routing logic: DRAFT → target status ---

export function routeDraftTask(
  task: TaskProperties,
  allTasks: TaskProperties[]
): { target: TaskStatus | null; reason: string } {
  // 1. Contract completeness
  const contract = checkContractCompleteness(task);
  if (!contract.ok) {
    return { target: null, reason: `Contract incomplete: ${contract.errors.join('; ')}` };
  }

  // 2. Manual decision blocks
  if (checkManualDecision(task)) {
    return { target: null, reason: 'Manual decision point set' };
  }

  // 3. Scheduled time not reached
  if (!checkScheduledTime(task)) {
    return { target: null, reason: 'Scheduled time not reached' };
  }

  // 4. Prerequisites
  const [prereqOk, prereqMsg] = checkPrerequisites(task, allTasks);
  if (!prereqOk) {
    return { target: null, reason: `Prerequisite: ${prereqMsg}` };
  }

  // 5. Duplicate check
  const [dupOk, dupMsg] = checkDuplicateTaskId(task, allTasks);
  if (!dupOk) {
    return { target: null, reason: `Duplicate: ${dupMsg}` };
  }

  // 6. Max retries
  const [retryOk, retryMsg] = checkMaxRetries(task);
  if (!retryOk) {
    return { target: null, reason: `Retries: ${retryMsg}` };
  }

  // 7. Route to executor
  const executor = task['执行方'];
  switch (executor) {
    case 'Worker A':
      return { target: 'WAITING_FOR_WORKER_A', reason: 'Routed to Worker A' };
    case 'Worker B':
      return { target: 'WAITING_FOR_WORKER_B', reason: 'Routed to Worker B' };
    case 'Notion AI':
      return { target: 'WAITING_FOR_NOTION_AI', reason: 'Routed to Notion AI' };
    case 'Primary':
      // Primary 通道有独立等待队列，由唯一 Dispatcher 以 CAS 领取
      return { target: 'WAITING_FOR_PRIMARY', reason: 'Routed to Primary' };
    default:
      return { target: null, reason: `Unknown executor: ${executor}` };
  }
}

// --- Gate status sync ---

export function computeGateStatus(task: TaskProperties): string {
  if (task['状态'] === 'DONE' || task['状态'] === 'CLOSED') {
    return 'GO';
  }
  if (task['状态'] === 'KILLED') {
    return 'KILL';
  }
  if (task['重试次数'] && task['重试次数'] >= (task['最大自动重试'] || 2)) {
    return 'RECYCLE';
  }
  if (task['状态'] === 'NEEDS_USER') {
    return 'HOLD';
  }
  if (task['状态'] === 'RUNNING') {
    return 'IN_PROGRESS';
  }
  return 'PENDING';
}

// --- Project progress aggregation ---

export function computeProjectProgress(
  projectTasks: TaskProperties[]
): number {
  if (projectTasks.length === 0) return 0;
  const done = projectTasks.filter(t => ['DONE', 'CLOSED'].includes(t['状态'])).length;
  return Math.round((done / projectTasks.length) * 100);
}

export function computeProjectPhase(
  projectTasks: TaskProperties[]
): string {
  if (projectTasks.length === 0) return 'NOT_STARTED';
  const allDone = projectTasks.every(t => ['DONE', 'CLOSED'].includes(t['状态']));
  if (allDone) return 'COMPLETED';

  const anyRunning = projectTasks.some(t => t['状态'] === 'RUNNING');
  if (anyRunning) return 'IN_PROGRESS';

  const anyWaiting = projectTasks.some(t =>
    ['WAITING_FOR_WORKER_A', 'WAITING_FOR_WORKER_B', 'WAITING_FOR_NOTION_AI'].includes(t['状态'])
  );
  if (anyWaiting) return 'QUEUED';

  return 'PLANNING';
}

// --- v5: Gate title computation (pure function) ---
// 生成 Gate n/总数｜业务名称 标题前缀
// 规则：只替换 Gate n/总数｜ 前缀，保留分隔符后的业务名称
// 缺少序号、总数、所属项目或标题无法安全解析时，返回 null（不猜测、不写入）

export function computeGateTitle(
  seq: number | string | null,
  total: number | null,
  currentTitle: string
): string | null {
  // 1. 必要输入校验
  if (seq == null || seq === '' || total == null || total <= 0) {
    return null;
  }
  const seqNum = typeof seq === 'string' ? parseInt(seq, 10) : seq;
  if (isNaN(seqNum) || seqNum <= 0) {
    return null;
  }

  // 2. 解析现有标题，提取业务名称（分隔符后部分）
  // 支持格式: "Gate n/总数｜业务名称" 或 "Gate n｜业务名称" 或 纯业务名称
  const separator = '｜';
  let businessName = currentTitle;
  if (currentTitle.includes(separator)) {
    // 取第一个分隔符后的业务名称（保留后续可能含｜的业务内容）
    const idx = currentTitle.indexOf(separator);
    businessName = currentTitle.substring(idx + 1);
  } else if (currentTitle.match(/^Gate\s+\d+[A-Za-z]?\/?\d*\s*[:：-]\s*/)) {
    // 兼容旧分隔符
    businessName = currentTitle.replace(/^Gate\s+\d+[A-Za-z]?\/?\d*\s*[:：-]\s*/, '');
  }

  if (!businessName || !businessName.trim()) {
    return null;
  }

  // 3. 检测分支后缀（如 2A, 2B）
  const branchMatch = String(seq).match(/^(\d+)([A-Za-z]+)$/);
  const gateNum = branchMatch ? `${branchMatch[1]}${branchMatch[2]}` : String(seqNum);

  // 4. 构建新标题
  return `Gate ${gateNum}/${total}｜${businessName.trim()}`;
}

// --- Health status ---

export function computeHealthStatus(
  tasks: TaskProperties[]
): string {
  const running = tasks.filter(t => t['状态'] === 'RUNNING');
  const stuck = running.filter(t => {
    if (!t['上次心跳']) return true;
    const lastHeartbeat = new Date(t['上次心跳']);
    const now = new Date();
    return (now.getTime() - lastHeartbeat.getTime()) > 30 * 60 * 1000; // 30 min
  });

  if (stuck.length > 0) return 'ATTENTION';
  if (running.length > 3) return 'BUSY';
  return 'HEALTHY';
}
