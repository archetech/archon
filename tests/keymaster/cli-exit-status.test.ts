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

// The handlers of a CLI, each with the command it belongs to.
function handlers(file: string): { command: string; body: ts.Node }[] {
    const parsed = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const found: { command: string; body: ts.Node }[] = [];

    // The .command('name …') a chained call hangs from.
    function commandOf(node: ts.Node): string | undefined {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
            return undefined;
        }

        const [first] = node.arguments;

        return node.expression.name.text === 'command' && first && ts.isStringLiteral(first)
            ? first.text.split(' ')[0]
            : commandOf(node.expression.expression);
    }

    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'action') {
            const command = commandOf(node.expression.expression);

            node.arguments.forEach(body => found.push({ command: command ?? '?', body }));
        }

        ts.forEachChild(node, visit);
    }

    visit(parsed);

    return found;
}

// The calls to a function, or to a method of console, in a handler.
function callsIn(body: ts.Node, name: string): ts.CallExpression[] {
    const found: ts.CallExpression[] = [];

    function walk(node: ts.Node): void {
        if (ts.isCallExpression(node) && node.expression.getText() === name) {
            found.push(node);
        }

        ts.forEachChild(node, walk);
    }

    walk(body);

    return found;
}

// The commands whose handler holds the node's answer to a write in `ok`.
function writeCommands(file: string): { command: string; body: ts.Node }[] {
    return handlers(file).filter(({ body }) => /\bconst ok = await keymaster\./.test(body.getText()));
}

describe('CLI exit status', () => {
    it.each(CLIS)('%s reports every command failure through fail()', (file) => {
        expect(bareReportsInHandlers(file)).toStrictEqual([]);
    });

    it.each(CLIS)('%s sets a failing status when it reports one', (file) => {
        const source = readFileSync(file, 'utf-8');

        expect(source).toContain('process.exitCode = 1;');
    });

    it.each(CLIS)('%s has write commands to check', (file) => {
        expect(writeCommands(file).length).toBeGreaterThan(30);
        expect(writeCommands(file).map(each => each.command)).toEqual(
            expect.arrayContaining(['revoke-did', 'rotate-keys', 'change-registry', 'update-grant', 'revoke-grant', 'accept-credential']));
    });

    // A write the node refuses is a failure. Printing the refusal on standard
    // output leaves the status at 0, and `revoke-did <id> && next` runs next.
    it.each(CLIS)('%s reports the outcome of every write through reportWrite() or fail()', (file) => {
        const unreported = writeCommands(file)
            .filter(({ body }) => callsIn(body, 'reportWrite').length === 0
                && !callsIn(body, 'fail').some(call => call.arguments[0]?.getText() === 'UPDATE_FAILED')
                && !/if \(!ok\) \{\s+fail\(/.test(body.getText()))
            .map(each => each.command);

        expect(unreported).toStrictEqual([]);
    });

    it.each(CLIS)('%s prints no failure on standard output', (file) => {
        const printed = handlers(file).flatMap(({ command, body }) => callsIn(body, 'console.log')
            .filter(call => /UPDATE_FAILED|\bok \?|['"](failed|Failed)['"]/.test(call.getText()))
            .map(call => `${command}: ${call.getText()}`));

        expect(printed).toStrictEqual([]);
    });

    it.each(CLIS)('%s fails the process for a write the node refused', (file) => {
        const source = readFileSync(file, 'utf-8');
        const helper = source.slice(source.indexOf('function reportWrite('), source.indexOf('// The registry a grant was created on'));

        expect(helper).toMatch(/if \(ok\) \{\s+console\.log\(done\);\s+\}\s+else \{\s+fail\(refused\);\s+\}/);
    });

    it('gives both CLIs the same write commands', () => {
        const [packageCli, scriptCli] = CLIS.map(file => writeCommands(file).map(each => each.command).sort());

        expect(scriptCli).toStrictEqual(packageCli);
    });
});
