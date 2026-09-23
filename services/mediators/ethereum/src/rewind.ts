// Find a stored checkpoint that still belongs to the canonical chain. A fixed
// rewind depth is only a starting point, not evidence that its predecessor survived.
export async function rescanStart(
    proposed: number, start: number,
    storedBlock: (height: number) => Promise<{ hash: string } | null>,
    canonicalHash: (height: number) => Promise<string>,
): Promise<number> {
    for (let height = proposed - 1; height >= start; height--) {
        const stored = await storedBlock(height);
        if (stored && stored.hash === await canonicalHash(height)) return height + 1;
    }
    return start;
}
