import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthDetailsModal from '../../../../packages/wallet-ui/src/components/AuthDetailsModal';

// The dialog the Vaults tab opens to add a login to a vault or to show one
// that is in it.

const login = { service: 'example.org', username: 'alice', password: 'hunter2' };

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe('the login details dialog', () => {
    it('shows nothing while closed', () => {
        render(<AuthDetailsModal open={false} onClose={vi.fn()} />);

        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('starts empty, and offers OK only once every field is filled', async () => {
        const user = userEvent.setup({ delay: null });
        const onOK = vi.fn();
        render(<AuthDetailsModal open onClose={vi.fn()} onOK={onOK} />);

        expect(screen.getByRole('heading', { name: 'Login' })).toBeTruthy();
        expect(field('Service').value).toBe('');
        const ok = screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement;
        expect(ok.disabled).toBe(true);

        await user.type(field('Service'), 'example.org');
        await user.type(field('Username'), 'alice');
        expect(ok.disabled).toBe(true);
        await user.type(field('Password'), 'hunter2');
        expect(ok.disabled).toBe(false);

        await user.click(ok);
        expect(onOK).toHaveBeenCalledWith('example.org', 'alice', 'hunter2');
    });

    it('hides the password until asked to show it', async () => {
        const user = userEvent.setup({ delay: null });
        render(<AuthDetailsModal open onClose={vi.fn()} login={login} />);

        expect(field('Password').type).toBe('password');
        await user.click(screen.getByRole('button', { name: 'Show password' }));
        expect(field('Password').type).toBe('text');
        await user.click(screen.getByRole('button', { name: 'Show password' }));
        expect(field('Password').type).toBe('password');
    });

    it('shows a login read-only, and OK closes it when there is nothing to save', async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        render(<AuthDetailsModal open onClose={onClose} login={login} readOnly />);

        expect(field('Service').value).toBe('example.org');
        expect(field('Username').value).toBe('alice');
        expect(field('Password').value).toBe('hunter2');
        expect(field('Service').readOnly).toBe(true);
        expect(field('Username').readOnly).toBe(true);
        expect(field('Password').readOnly).toBe(true);

        await user.type(field('Username'), 'mallory');
        expect(field('Username').value).toBe('alice');

        await user.click(screen.getByRole('button', { name: 'OK' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on Cancel without saving', async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        const onOK = vi.fn();
        render(<AuthDetailsModal open onClose={onClose} onOK={onOK} login={login} />);

        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onOK).not.toHaveBeenCalled();
    });

    it('closes on Escape', async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        render(<AuthDetailsModal open onClose={onClose} />);

        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows the login it is given when reopened, and hides the password again', async () => {
        const user = userEvent.setup({ delay: null });
        const shown = render(<AuthDetailsModal open onClose={vi.fn()} login={login} />);
        await user.click(screen.getByRole('button', { name: 'Show password' }));
        await user.clear(field('Username'));
        await user.type(field('Username'), 'edited');

        // Closed and opened again with the same login: what was typed is gone and the password is hidden.
        const onClose = vi.fn();
        shown.rerender(<AuthDetailsModal open={false} onClose={onClose} login={login} />);
        shown.rerender(<AuthDetailsModal open onClose={onClose} login={login} />);

        expect(field('Username').value).toBe('alice');
        expect(field('Password').type).toBe('password');

        const other = { service: 'other.org', username: 'bob', password: 'secret' };
        shown.rerender(<AuthDetailsModal open onClose={onClose} login={other} />);

        expect(field('Service').value).toBe('other.org');
        expect(field('Username').value).toBe('bob');
        expect(field('Password').type).toBe('password');
    });
});
