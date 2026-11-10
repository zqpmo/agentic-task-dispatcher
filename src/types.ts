// Shared types for the deterministic multi-database task dispatcher

export interface NotionConfig {
  data_sources: {
    tasks: string;
    projects: string;
    records: string;
  };
}

export interface DispatcherConfig {
  interval_minutes: number;
  max_candidates: number;
  dry_run: boolean;
  log_file: string;
}

export interface RunnerConfig {
  interval_minutes: number;
  offset_minutes: number;
  max_concurrent: number;
  dry_run: boolean;
  log_file: string;
}

export interface ConcurrencyConfig {
  hard_limit: number;
  soft_limit: number;
  third_slot_conditions: {
    parallel_mode_required: boolean;
    no_prerequisites: boolean;
    no_file_conflicts: boolean;
    no_p3_data: boolean;
    no_external_coder_if_running: boolean;
    short_duration_only: boolean;
  };
}

export interface AppConfig {
  notion: NotionConfig;
  dispatcher: DispatcherConfig;
  runner: RunnerConfig;
  concurrency: ConcurrencyConfig;
  statuses: Record<string, string>;
  task_types: Record<string, string>;
}

// --- Task properties (from Notion task DB schema) ---
export interface TaskProperties {
  id: string;
  url: string;
  "任务名称": string;
  "Task ID": string;
  "Gate序号": number | string;
  "优先级": string;
  "状态": string;
  "执行方": string;
  "执行模式": string;
  "任务时长": string;
  "任务类型": string;
  "任务域": string;
  "任务子域": string;
  "数据等级": string;
  "前置任务": string;
  "人工判断点": boolean;
  "允许自动关闭": boolean;
  "允许调用外部编码代理": boolean;
  "自动派活": boolean;
  "计划时间": string;
  "开始时间": string;
  "Run ID": string;
  "执行会话": string;
  "领取前预检": string;
  "执行可观测Gate": string;
  "提交前Gate": string;
  "提交前Gate报告": string;
  "当前里程碑": string;
  "所属项目": string[];
  "版本号": number;
  "需求版本": number;
  "需求Hash": string;
  "证据包Hash": string;
  "结果": string;
  "结果摘要": string;
  "结果证据": string;
  "进度": number;
  "等待原因": string;
  "释放条件": string;
  "变更摘要": string;
  "变更路径": string;
  "修正策略": string;
  "返工根因": string;
  "最后错误": string;
  "最大自动重试": number;
  "重试次数": number;
  "契约完整性": string;
  "执行评价": string;
  "执行通道": string;
  "并行组": string;
  "更新时间": string;
  "上次心跳": string;
  "反馈时间": string;
  "下次反馈": string;
  "租约到期": string;
  "领取批次": string;
  "Obsidian路径": string;
  "RE复核意见": string;
  "需求变更处置": string;
  "页面ID": string;
  // Automation metadata
  "Automation Run ID": string;
  "Update Source": string;
}

// --- Project properties ---
export interface ProjectProperties {
  id: string;
  url: string;
  "项目名称": string;
  "Project ID": string;
  "状态": string;
  "阶段": string;
  "进度": number;
  "基线版本": string;
  "基线Hash": string;
  "健康度": string;
  "版本号": number;
  // v4: 计划步骤总数
  "计划步骤总数": number;
  "Automation Run ID": string;
  "Update Source": string;
}

// --- Record (Run/Gate/Model Event) properties ---
export interface RecordProperties {
  id: string;
  url: string;
  "记录类型": string;
  "Task ID": string;
  "Run ID": string;
  "Gate序号": string;
  "Gate状态": string;
  "模型": string;
  "Provider": string;
  "步骤": string;
  "原因": string;
  "时间": string;
  "Token": number;
  "成本": number;
  "影响": string;
  "证据摘要": string;
  "版本号": number;
  // v4: 可视化编号体系
  "序号": number | string;
  "纳入流程": boolean;
  "总步骤数": number;
  "流程标识": string;
  "记录显示名": string;
  "记录名称": string;
  "所属项目": string[];
  "Automation Run ID": string;
  "Update Source": string;
}

// --- Contract check result ---
export interface ContractCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// --- Reconciliation finding ---
export interface ReconciliationFinding {
  type: string;
  severity: "error" | "warning" | "info";
  record_id: string;
  description: string;
  suggestion: string;
}

// --- State machine transitions ---
export type TaskStatus =
  | "DRAFT"
  | "WAITING_FOR_PRIMARY"
  | "WAITING_FOR_WORKER_A"
  | "WAITING_FOR_WORKER_B"
  | "WAITING_FOR_NOTION_AI"
  | "RUNNING"
  | "NEEDS_USER"
  | "DONE"
  | "CLOSED"
  | "KILLED"
  | "ERROR";

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  DRAFT: ["WAITING_FOR_PRIMARY", "WAITING_FOR_WORKER_A", "WAITING_FOR_WORKER_B", "WAITING_FOR_NOTION_AI", "NEEDS_USER"],
  WAITING_FOR_PRIMARY: ["RUNNING", "NEEDS_USER", "DRAFT", "ERROR"],
  WAITING_FOR_WORKER_A: ["RUNNING", "NEEDS_USER", "DRAFT", "ERROR"],
  WAITING_FOR_WORKER_B: ["RUNNING", "NEEDS_USER", "DRAFT", "ERROR"],
  WAITING_FOR_NOTION_AI: ["RUNNING", "NEEDS_USER"],
  RUNNING: ["WAITING_FOR_NOTION_AI", "NEEDS_USER", "DONE", "ERROR"],
  NEEDS_USER: ["WAITING_FOR_PRIMARY", "WAITING_FOR_WORKER_A", "WAITING_FOR_WORKER_B", "DRAFT", "KILLED"],
  DONE: ["WAITING_FOR_NOTION_AI", "CLOSED"],
  CLOSED: [],
  KILLED: [],
  ERROR: ["WAITING_FOR_PRIMARY", "DRAFT", "NEEDS_USER", "KILLED"],
};

// 不可回退终态（CLOSED 与已进入 Notion AI 终审的 DONE 不得被旧事件退回）
export const TERMINAL_STATUSES: TaskStatus[] = ["CLOSED", "KILLED"];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status);
}

// --- Exit codes ---
export enum ExitCode {
  OK = 0,
  PARTIAL = 2,
  ERROR = 3,
  LOCKED = 4,
}

// --- Log levels ---
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

// --- Run context ---
export interface RunContext {
  runId: string;
  timestamp: string;
  dryRun: boolean;
  once: boolean;
  reconcile: boolean;
  cursor: string;
}
