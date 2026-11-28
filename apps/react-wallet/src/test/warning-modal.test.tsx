import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WarningModal from '../../../../packages/wallet-ui/src/components/WarningModal';
import ClientWarningModal from '../../../../packages/keymaster-ui/src/WarningModal.jsx';

// The dialog that asks for confirmation before a destructive action, in the
// wallets and in the standalone clients.

describe.each([
    ['wallet', WarningModal],
    ['standalone client', ClientWarningModal],
])('the %s confirmation dialog', (_surface, Modal) => {
    it('is named by its title and described by its warning', () => {
        render(
            <Modal
                isOpen
                title="Remove Identity"
                warningText="Are you sure you want to remove alice?"
                onSubmit={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const dialog = screen.getByRole('dialog', { name: 'Remove Identity' });
        expect(dialog).toHaveAccessibleDescription('Are you sure you want to remove alice?');
    });

    it('confirms on Confirm and closes on Cancel', async () => {
        const user = userEvent.setup({ delay: null });
        const onSubmit = vi.fn();
        const onClose = vi.fn();
        render(<Modal isOpen title="Remove" warningText="Sure?" onSubmit={onSubmit} onClose={onClose} />);

        await user.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(onSubmit).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
