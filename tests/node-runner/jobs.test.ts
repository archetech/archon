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
