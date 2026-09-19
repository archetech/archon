// Deliberately restricted model: one self-controlled agent, valid data-only
// updates, no key changes, deletion, migrations, aliases, or unavailable content.
// Select children in an explicit priority order; do not reproduce importer code.
export function permutations(items) {
    if (!items.length) return [[]];
    return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index))
        .map(rest => [item, ...rest]));
}

export function project(operations, priority) {
    const genesis = operations.findIndex(op => op.type === 'create');
    const path = [genesis];
    for (;;) {
        const children = priority.filter(index => operations[index].parent === path.at(-1));
        if (!children.length) return path;
        const child = children[0];
        if (path.includes(child)) throw new Error('Model requires an acyclic predecessor graph');
        path.push(child);
    }
}
