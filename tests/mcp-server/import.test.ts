import { jest } from '@jest/globals';

describe('mcp server package import', () => {
    it('does not start stdio or exit when importing the library entrypoint', async () => {
        const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit should not be called');
        }) as never);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const module = await import('../../packages/mcp-server/src/index');

        expect(module.main).toBeInstanceOf(Function);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();

        exitSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
