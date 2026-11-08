import AutorenewIcon from '@mui/icons-material/Autorenew';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import { Box } from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import type { Health } from '../api';
import { HEALTH_LABEL } from '../format';

const LOOK: Record<Health, { icon: SvgIconComponent, color: string }> = {
    healthy: { icon: CheckCircleOutlineIcon, color: 'success.main' },
    unhealthy: { icon: ErrorOutlineIcon, color: 'error.main' },
    failed: { icon: ErrorOutlineIcon, color: 'error.main' },
    restarting: { icon: AutorenewIcon, color: 'warning.main' },
    starting: { icon: HourglassEmptyIcon, color: 'text.secondary' },
    running: { icon: RemoveCircleOutlineIcon, color: 'text.secondary' },
    completed: { icon: TaskAltIcon, color: 'text.secondary' },
    stopped: { icon: StopCircleOutlinedIcon, color: 'text.secondary' },
};

// Status is always an icon and a word, never color alone.
export default function StatusBadge({ health, suffix }: { health: Health, suffix?: string }) {
    const { icon: Icon, color } = LOOK[health];
    return (
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, color, fontSize: 13, fontWeight: 500 }}>
            <Icon sx={{ fontSize: 16 }} aria-hidden="true" />
            {HEALTH_LABEL[health]}{suffix ? ` · ${suffix}` : ''}
        </Box>
    );
}
