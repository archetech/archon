import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';

export type JobStatus = 'running' | 'succeeded' | 'failed';

export interface JobLine {
    time: string;
    text: string;
}

export interface Job {
    id: string;
    title: string;
    status: JobStatus;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
    lines: JobLine[];
}

export type JobSummary = Omit<Job, 'lines'>;

export class JobConflictError extends Error {
    readonly status = 409;
}

export class JobFailedError extends Error {}

export type JobLog = (text: string) => void;
export type JobWork = (log: JobLog, id: string) => Promise<void>;

const MAX_LINES = 5000;
const MAX_HISTORY = 20;
const HISTORY_FILE = 'jobs.json';
// How long new output of a running job waits before it is saved, so a
// restart mid-job keeps what it had printed.
const OUTPUT_SAVE_MS = 1000;

// Runs one job at a time, server-side, so it carries on when the browser
// that started it goes away. Output is kept per job and the last jobs are
// written to the data directory, so the history survives a restart.
export class JobRunner {
    private jobs: Job[] = [];
    private readonly listeners = new Map<string, Set<(event: { line?: JobLine, job: JobSummary }) => void>>();
    private loading: Promise<void> | null = null;
    private saving: Promise<void> = Promise.resolve();
    private outputTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly dataDir: string, private readonly now: () => Date = () => new Date()) {}

    private get historyPath(): string {
        return join(this.dataDir, HISTORY_FILE);
    }

    // Loaded once, and every caller waits on the same load: a second load
    // finishing later would replace jobs started in the meantime.
    private load(): Promise<void> {
        this.loading ??= this.readHistory();
        return this.loading;
    }

    private async readHistory(): Promise<void> {
        try {
            const saved = JSON.parse(await fs.readFile(this.historyPath, 'utf-8')) as Job[];
            // A job still marked running when node-runner stopped was cut short.
            this.jobs = saved.map(job => job.status === 'running'
                ? { ...job, status: 'failed', error: 'node-runner stopped while this job was running', finishedAt: job.finishedAt ?? job.startedAt }
                : job);
        }
        catch {
            this.jobs = [];
        }
    }

    // Saves run one after another, each replacing the file in one rename, so
    // overlapping saves cannot interleave or leave half-written JSON.
    private save(): Promise<void> {
        const write = async () => {
            await fs.mkdir(this.dataDir, { recursive: true });
            const tmp = `${this.historyPath}.${randomBytes(4).toString('hex')}`;
            await fs.writeFile(tmp, JSON.stringify(this.jobs.slice(0, MAX_HISTORY)), { mode: 0o600 });
            await fs.rename(tmp, this.historyPath);
        };
        const next = this.saving.then(write, write);
        this.saving = next.catch(() => {});
        return next;
    }

    private saveOutputSoon(): void {
        if (this.outputTimer) {
            return;
        }
        this.outputTimer = setTimeout(() => {
            this.outputTimer = null;
            this.save().catch(() => {});
        }, OUTPUT_SAVE_MS);
        // A pending save must not keep the process alive on its own.
        this.outputTimer.unref?.();
    }

    private summary(job: Job): JobSummary {
        const { lines: _lines, ...rest } = job;
        return rest;
    }

    private emit(job: Job, line?: JobLine): void {
        this.listeners.get(job.id)?.forEach(listener => listener({ line, job: this.summary(job) }));
    }

    async list(): Promise<JobSummary[]> {
        await this.load();
        return this.jobs.map(job => this.summary(job));
    }

    async get(id: string): Promise<Job | undefined> {
        await this.load();
        return this.jobs.find(job => job.id === id);
    }

    async active(): Promise<Job | undefined> {
        await this.load();
        return this.jobs.find(job => job.status === 'running');
    }

    subscribe(id: string, listener: (event: { line?: JobLine, job: JobSummary }) => void): () => void {
        const set = this.listeners.get(id) ?? new Set();
        set.add(listener);
        this.listeners.set(id, set);
        return () => set.delete(listener);
    }

    // Starts `work` and returns the job at once; `done` settles when it ends.
    async start(title: string, work: JobWork): Promise<{ job: Job, done: Promise<void> }> {
        await this.load();
        // Checked and claimed with no await in between, so two requests
        // arriving together cannot both start a job.
        const running = this.jobs.find(j => j.status === 'running');
        if (running) {
            throw new JobConflictError(`Another job is running: ${running.title}`);
        }
        const job: Job = {
            id: randomBytes(6).toString('hex'),
            title,
            status: 'running',
            startedAt: this.now().toISOString(),
            finishedAt: null,
            error: null,
            lines: [],
        };
        this.jobs.unshift(job);
        this.jobs = this.jobs.slice(0, MAX_HISTORY);
        try {
            await this.save();
        }
        catch (error) {
            // Not recorded, so not started: release the slot.
            this.jobs = this.jobs.filter(j => j !== job);
            throw error;
        }
        return { job, done: this.execute(job, work) };
    }

    private execute(job: Job, work: JobWork): Promise<void> {
        const log: JobLog = text => {
            const line = { time: this.now().toISOString(), text };
            job.lines.push(line);
            if (job.lines.length > MAX_LINES) {
                job.lines.splice(0, job.lines.length - MAX_LINES);
            }
            this.emit(job, line);
            this.saveOutputSoon();
        };

        return (async () => {
            try {
                await work(log, job.id);
                job.status = 'succeeded';
            }
            catch (error) {
                job.status = 'failed';
                job.error = error instanceof Error ? error.message : String(error);
                log(`Failed: ${job.error}`);
            }
            job.finishedAt = this.now().toISOString();
            await this.save().catch(() => {});
            this.emit(job);
        })();
    }
}
