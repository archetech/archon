import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JobConflictError, JobRunner } from '../../services/node-runner/server/src/jobs.ts';

let dataDir: string;

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'node-runner-jobs-'));
});

afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
});

describe('JobRunner', () => {
    it('runs a job, records its output and outcome, and saves the history privately', async () => {
        const jobs = new JobRunner(dataDir);
        const { job, done } = await jobs.start('Apply 1 change', async log => {
            log('one');
            log('two');
        });
        await done;

        const saved = await jobs.get(job.id);
        expect(saved).toMatchObject({ title: 'Apply 1 change', status: 'succeeded', error: null });
        expect(saved!.lines.map(l => l.text)).toEqual(['one', 'two']);
        expect(statSync(join(dataDir, 'jobs.json')).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(join(dataDir, 'jobs.json'), 'utf-8'))[0].status).toBe('succeeded');
    });

    it('records a failure with its message', async () => {
        const jobs = new JobRunner(dataDir);
        const { job, done } = await jobs.start('Fails', async () => {
            throw new Error('boom');
        });
        await done;

        const saved = await jobs.get(job.id);
        expect(saved).toMatchObject({ status: 'failed', error: 'boom' });
        expect(saved!.lines.at(-1)!.text).toBe('Failed: boom');
    });

    it('runs one job at a time, even when two start together', async () => {
        const jobs = new JobRunner(dataDir);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });

        const results = await Promise.allSettled([
            jobs.start('First', () => gate),
            jobs.start('Second', () => gate),
        ]);

        expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(JobConflictError);
        release();
        await (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ done: Promise<void> }>).value.done;
        await expect(jobs.start('Third', async () => {})).resolves.toBeDefined();
    });

    it('streams lines and the end to subscribers', async () => {
        const jobs = new JobRunner(dataDir);
        const events: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const { job, done } = await jobs.start('Streamed', async log => {
            await gate;
            log('hello');
        });
        jobs.subscribe(job.id, ({ line, job: summary }) => events.push(line ? `line:${line.text}` : `end:${summary.status}`));
        release();
        await done;

        expect(events).toEqual(['line:hello', 'end:succeeded']);
    });

    it('releases the slot when the job cannot be recorded', async () => {
        const jobs = new JobRunner(join(dataDir, 'jobs.json', 'not-a-dir'));
        writeFileSync(join(dataDir, 'jobs.json'), '[]');

        await expect(jobs.start('Unrecordable', async () => {})).rejects.toThrow();
        expect(await jobs.active()).toBeUndefined();
    });

    it('saves a running job\'s output, so a restart keeps it', async () => {
        const jobs = new JobRunner(dataDir);
        let release!: () => void;
        const { job, done } = await jobs.start('Long', async log => {
            log('backed up .env to somewhere');
            await new Promise<void>(resolve => { release = resolve; });
        });
        await new Promise(resolve => setTimeout(resolve, 1300));

        const saved = JSON.parse(readFileSync(join(dataDir, 'jobs.json'), 'utf-8'));
        expect(saved.find((j: { id: string }) => j.id === job.id).lines.map((l: { text: string }) => l.text)).toEqual(['backed up .env to somewhere']);
        release();
        await done;
    });

    it('keeps the history file whole when saves overlap', async () => {
        const jobs = new JobRunner(dataDir);
        for (let i = 0; i < 5; i++) {
            const { done } = await jobs.start(`Job ${i}`, async log => log(`line ${i}`));
            await done;
        }

        expect(JSON.parse(readFileSync(join(dataDir, 'jobs.json'), 'utf-8')).map((j: { title: string }) => j.title)).toEqual(['Job 4', 'Job 3', 'Job 2', 'Job 1', 'Job 0']);
    });

    it('marks a job cut short by a restart as failed, and keeps 20 jobs', async () => {
        writeFileSync(join(dataDir, 'jobs.json'), JSON.stringify(Array.from({ length: 20 }, (_, i) => ({
            id: `j${i}`, title: `Job ${i}`, status: i === 0 ? 'running' : 'succeeded', startedAt: '2026-11-08T10:00:00Z', finishedAt: null, error: null, lines: [],
        }))));
        const jobs = new JobRunner(dataDir);

        expect((await jobs.get('j0'))).toMatchObject({ status: 'failed', error: 'node-runner stopped while this job was running' });
        await (await jobs.start('New', async () => {})).done;
        const list = await jobs.list();
        expect(list).toHaveLength(20);
        expect(list[0].title).toBe('New');
        expect(list.some(j => j.id === 'j19')).toBe(false);
    });
});
