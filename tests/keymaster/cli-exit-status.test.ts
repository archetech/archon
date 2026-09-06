import { readFileSync } from 'fs';
import ts from 'typescript';

// A command that reports a failure has to fail the process too, or
// `archon create-id alice && next` runs next after alice failed and no script
// or CI step can tell (#1054). Every handler reports through fail(), which
// sets the status; a bare console.error inside a handler is the shape that
// loses it, so the one message that is not a failure says so by calling
// notice() instead.

const CLIS = [
    'packages/keymaster/src/cli.ts',
    'scripts/archon-cli.js',
];

function bareReportsInHandlers(file: string): string[] {
    const parsed = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const found: string[] = [];

    function isConsoleError(node: ts.Node): boolean {
        return ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            && node.expression.expression.text === 'console'
            && node.expression.name.text === 'error';
    }

    function walkHandler(node: ts.Node): void {
        if (isConsoleError(node)) {
            found.push(`${file}:${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }

        ts.forEachChild(node, walkHandler);
    }

    function visit(node: ts.Node): void {
        // .action(handler) -- the body of a command.
        if (ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'action') {
            node.arguments.forEach(walkHandler);
        }

        ts.forEachChild(node, visit);
    }

    visit(parsed);

    return found;
}

describe('CLI exit status', () => {
    it.each(CLIS)('%s reports every command failure through fail()', (file) => {
        expect(bareReportsInHandlers(file)).toStrictEqual([]);
    });

    it.each(CLIS)('%s sets a failing status when it reports one', (file) => {
        const source = readFileSync(file, 'utf-8');

        expect(source).toContain('process.exitCode = 1;');
    });
});
