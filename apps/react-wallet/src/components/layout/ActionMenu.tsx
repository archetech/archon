import { ReactNode, useId, useState } from "react";
import { Button, Divider, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { MoreHoriz } from "@mui/icons-material";

// Seven equally-weighted contained buttons in a wrapping row was the single
// loudest thing about these screens: nothing was primary because everything was.
// Secondary and destructive actions move in here, leaving one primary button
// visible. Destructive items are separated and coloured so "Remove" is not one
// mis-click away from "Rename".

export interface ActionMenuItem {
    label: string;
    onClick: () => void;
    icon?: ReactNode;
    disabled?: boolean;
    destructive?: boolean;
}

export default function ActionMenu(
    {
        items,
        label = "Manage",
    }: {
        items: ActionMenuItem[];
        label?: string;
    }) {
    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const id = useId();
    const buttonId = `action-menu-button-${id}`;
    const menuId = `action-menu-${id}`;

    if (!items.length) {
        return null;
    }

    const regular = items.filter(item => !item.destructive);
    const destructive = items.filter(item => item.destructive);

    function run(item: ActionMenuItem) {
        setAnchorEl(null);
        item.onClick();
    }

    function renderItem(item: ActionMenuItem) {
        return (
            <MenuItem
                key={item.label}
                onClick={() => run(item)}
                disabled={item.disabled}
                sx={item.destructive ? { color: "error.main" } : undefined}
            >
                {item.icon && (
                    <ListItemIcon sx={item.destructive ? { color: "error.main" } : undefined}>
                        {item.icon}
                    </ListItemIcon>
                )}
                <ListItemText>{item.label}</ListItemText>
            </MenuItem>
        );
    }

    return (
        <>
            <Button
                variant="outlined"
                onClick={(event) => setAnchorEl(event.currentTarget)}
                endIcon={<MoreHoriz />}
                id={buttonId}
                aria-haspopup="menu"
                aria-expanded={open ? true : undefined}
                aria-controls={open ? menuId : undefined}
            >
                {label}
            </Button>

            <Menu
                id={menuId}
                anchorEl={anchorEl}
                open={open}
                MenuListProps={{ "aria-labelledby": buttonId }}
                onClose={() => setAnchorEl(null)}
                anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                transformOrigin={{ vertical: "top", horizontal: "right" }}
                slotProps={{ paper: { sx: { minWidth: 200 } } }}
            >
                {regular.map(renderItem)}
                {destructive.length > 0 && regular.length > 0 && <Divider />}
                {destructive.map(renderItem)}
            </Menu>
        </>
    );
}
