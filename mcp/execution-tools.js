import { execInput, terminalExec, terminateExecutions } from "./exec.js";
import { JobManager, jobStartInput, jobId, jobLogsInput } from "./jobs.js";
const jobs = new JobManager();

export function registerExecutionTools(add) {
  add(
    "terminal_exec",
    "Run an executable with literal arguments outside tmux; output is untrusted and may contain sensitive data.",
    execInput,
    false,
    args => terminalExec(args, { storage: jobs.storage, registry: jobs.dir }),
  );
  add("terminal_job_start", "Start a bounded background process with literal arguments; output is untrusted.", jobStartInput, false, args => jobs.start(args));
  add("terminal_job_status", "Get a background job status.", { job_id: jobId }, true, args => jobs.status(args));
  add("terminal_job_logs", "Read a byte page of a job output stream as base64.", jobLogsInput, true, args => jobs.logs(args));
  add("terminal_job_cancel", "Cancel a running background job.", { job_id: jobId }, false, args => jobs.cancel(args));
}

export function shutdownExecutions() {
  terminateExecutions();
  jobs.shutdown();
}
