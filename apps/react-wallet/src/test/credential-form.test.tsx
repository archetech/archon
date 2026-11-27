import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import CredentialForm from '../../../../packages/wallet-ui/src/components/CredentialForm';

// The credential form draws one field for each property of a schema and hands
// its parent the credential with those values as its subject.

const { setError } = vi.hoisted(() => ({ setError: vi.fn() }));
vi.mock('../../../../packages/wallet-ui/src/contexts/SnackbarProvider', () => ({ useSnackbar: () => ({ setError }) }));

const BOB = 'did:cid:bob';
const BASE = JSON.stringify({
    type: ['VerifiableCredential'],
    issuer: 'did:cid:alice',
    credentialSubject: { id: BOB, email: 'placeholder' },
});

const onChange = vi.fn<(credential: string, valid: boolean) => void>();

beforeEach(() => {
    vi.resetAllMocks();
});

function show(schemaObject: object, baseCredential = BASE) {
    return render(<CredentialForm schemaObject={schemaObject} baseCredential={baseCredential} onChange={onChange} />);
}

// The credential last handed to the parent.
function handedOver() {
    const [credential, valid] = onChange.mock.calls[onChange.mock.calls.length - 1];
    return { credential: JSON.parse(credential), valid };
}

const subject = () => handedOver().credential.credentialSubject;

// JSON is pasted: typing it would have user-event read `{` and `[` as key names.
async function paste(user: UserEvent, field: HTMLElement, text: string) {
    await user.clear(field);
    await user.click(field);
    await user.paste(text);
}

async function pick(user: UserEvent, picker: HTMLElement, option: string) {
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: option }));
}

describe('the fields of a schema', () => {
    it('shows a field for each property that has a type, labelled with the type', () => {
        show({
            properties: {
                name: { type: 'string' },
                age: { type: 'integer' },
                score: { type: 'number' },
                active: { type: 'boolean' },
                tags: { type: 'array' },
                address: { properties: { city: { type: 'string' } } },
                choice: { enum: ['a', 'b'] },
                nothing: { type: 'null' },
            },
            required: ['name'],
        });

        expect(screen.getByLabelText(/^name \(string\)/)).toBeRequired();
        expect(screen.getByLabelText(/^age \(integer\)/)).toHaveAttribute('step', '1');
        expect(screen.getByLabelText(/^score \(number\)/)).not.toHaveAttribute('step');
        expect(screen.getByLabelText(/^score \(number\)/)).not.toBeRequired();
        expect(screen.getByRole('combobox', { name: /^active \(boolean\)/ })).toBeInTheDocument();
        expect(screen.getByLabelText(/^tags \(array\)/)).toBeInTheDocument();
        expect(screen.getByText('Enter a JSON array')).toBeInTheDocument();
        // A property with nested properties and no type is an object.
        expect(screen.getByLabelText(/^address \(object\)/)).toBeInTheDocument();
        expect(screen.getByText('Enter a JSON object')).toBeInTheDocument();
        expect(screen.queryByLabelText(/^choice/)).toBeNull();
        expect(screen.queryByLabelText(/^nothing/)).toBeNull();
    });

    it('shows a property that may also be null as a plain field of its other type', () => {
        show({ properties: { nickname: { type: ['string', 'null'] } } });

        expect(screen.getByLabelText(/^nickname \(string\)/)).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).toBeNull();
    });

    it('shows the fields of a new schema when the schema changes', () => {
        const shown = show({ properties: { name: { type: 'string' } } });
        onChange.mockClear();

        shown.rerender(
            <CredentialForm
                schemaObject={{ properties: { name: { type: 'string' }, city: { type: 'string' } } }}
                baseCredential={BASE}
                onChange={onChange}
            />,
        );

        expect(screen.getByLabelText(/^city \(string\)/)).toBeInTheDocument();
        expect(onChange).toHaveBeenCalled();
    });
});

describe('the credential handed to the parent', () => {
    it('is handed over at once when the schema requires nothing', () => {
        show({ properties: { name: { type: 'string' } } });

        expect(handedOver().valid).toBe(true);
        expect(handedOver().credential.issuer).toBe('did:cid:alice');
        // The subject keeps its DID; its other values come from the form alone.
        expect(subject()).toEqual({ id: BOB });
        expect(setError).not.toHaveBeenCalled();
    });

    it('waits for every required field', async () => {
        const user = userEvent.setup({ delay: null });
        show({
            properties: { name: { type: 'string' }, city: { type: 'string' } },
            // A required name the schema has no property for is not waited for.
            required: ['name', 'city', 'absent'],
        });

        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getAllByText('This field is required')).toHaveLength(2);

        await user.type(screen.getByLabelText(/^name \(string\)/), 'Bob');
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getAllByText('This field is required')).toHaveLength(1);

        await user.type(screen.getByLabelText(/^city \(string\)/), 'Oslo');
        expect(screen.queryByText('This field is required')).toBeNull();
        expect(handedOver().valid).toBe(true);
        expect(subject()).toEqual({ id: BOB, name: 'Bob', city: 'Oslo' });
    });

    it('requires nothing when the schema\'s required is not a list', () => {
        show({ properties: { name: { type: 'string' } }, required: 'name' });

        expect(screen.getByLabelText(/^name \(string\)/)).not.toBeRequired();
        expect(handedOver().valid).toBe(true);
    });

    it('writes each value in the type of its property', async () => {
        const user = userEvent.setup({ delay: null });
        show({
            properties: {
                name: { type: 'string' },
                age: { type: 'integer' },
                score: { type: 'number' },
                active: { type: 'boolean' },
                tags: { type: 'array' },
                address: { type: 'object' },
                unused: { type: 'string' },
            },
        });

        await user.type(screen.getByLabelText(/^name \(string\)/), '42');
        await user.type(screen.getByLabelText(/^age \(integer\)/), '42');
        await user.type(screen.getByLabelText(/^score \(number\)/), '1.5');
        await pick(user, screen.getByRole('combobox', { name: /^active \(boolean\)/ }), 'True');
        await paste(user, screen.getByLabelText(/^tags \(array\)/), '["a", "b"]');
        await paste(user, screen.getByLabelText(/^address \(object\)/), '{"city": "Oslo"}');

        // A field left empty is left out of the subject.
        expect(subject()).toEqual({
            id: BOB,
            name: '42',
            age: 42,
            score: 1.5,
            active: true,
            tags: ['a', 'b'],
            address: { city: 'Oslo' },
        });

        await pick(user, screen.getByRole('combobox', { name: /^active \(boolean\)/ }), 'False');
        expect(subject().active).toBe(false);
    });

    it('gives the subject no DID when the base credential has none', async () => {
        const user = userEvent.setup({ delay: null });
        show({ properties: { name: { type: 'string' } } }, JSON.stringify({ type: ['VerifiableCredential'] }));

        await user.type(screen.getByLabelText(/^name \(string\)/), 'Bob');

        expect(subject()).toEqual({ name: 'Bob' });
    });

    it('passes on as typed a value whose type it does not know', async () => {
        const user = userEvent.setup({ delay: null });
        show({ properties: { born: { type: 'date' } } });

        await user.type(screen.getByLabelText(/^born \(date\)/), '2001-02-03');

        expect(subject()).toEqual({ id: BOB, born: '2001-02-03' });
    });

    it('reports a base credential that is not JSON', () => {
        show({ properties: { name: { type: 'string' } } }, 'not json');

        expect(setError).toHaveBeenCalledWith('Invalid base credential JSON');
    });
});

describe('checking what is typed', () => {
    it('refuses a fraction in an integer field', async () => {
        const user = userEvent.setup({ delay: null });
        show({ properties: { age: { type: 'integer' } } });

        await user.type(screen.getByLabelText(/^age \(integer\)/), '1.5');
        expect(screen.getByText('Must be an integer')).toBeInTheDocument();

        await user.clear(screen.getByLabelText(/^age \(integer\)/));
        await user.type(screen.getByLabelText(/^age \(integer\)/), '7');
        expect(screen.queryByText('Must be an integer')).toBeNull();
        expect(subject()).toEqual({ id: BOB, age: 7 });
    });

    it('refuses anything but a JSON array in an array field', async () => {
        const user = userEvent.setup({ delay: null });
        show({ properties: { tags: { type: 'array' } } });
        const field = screen.getByLabelText(/^tags \(array\)/);

        await paste(user, field, 'a, b');
        expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
        expect(screen.queryByText('Enter a JSON array')).toBeNull();

        await paste(user, field, '{"a": 1}');
        expect(screen.getByText('Must be a JSON array')).toBeInTheDocument();

        await paste(user, field, '[1, 2]');
        expect(screen.getByText('Enter a JSON array')).toBeInTheDocument();
        expect(subject()).toEqual({ id: BOB, tags: [1, 2] });
    });

    it('refuses anything but a JSON object in an object field', async () => {
        const user = userEvent.setup({ delay: null });
        show({ properties: { address: { type: 'object' } } });
        const field = screen.getByLabelText(/^address \(object\)/);

        await paste(user, field, 'city: Oslo');
        expect(screen.getByText('Invalid JSON')).toBeInTheDocument();

        for (const notAnObject of ['[1, 2]', 'null', '"Oslo"']) {
            await paste(user, field, notAnObject);
            expect(screen.getByText('Must be a JSON object')).toBeInTheDocument();
        }

        await paste(user, field, '{"city": "Oslo"}');
        expect(screen.getByText('Enter a JSON object')).toBeInTheDocument();
        expect(subject()).toEqual({ id: BOB, address: { city: 'Oslo' } });
    });

    it('marks a required boolean that has no answer', async () => {
        const user = userEvent.setup({ delay: null });
        show({ properties: { active: { type: 'boolean' } }, required: ['active'] });

        expect(screen.getByText('This field is required')).toBeInTheDocument();
        expect(onChange).not.toHaveBeenCalled();

        await pick(user, screen.getByRole('combobox', { name: /^active \(boolean\)/ }), 'False');

        expect(screen.queryByText('This field is required')).toBeNull();
        expect(subject()).toEqual({ id: BOB, active: false });
    });
});

describe('a property of more than one type', () => {
    const schema = {
        properties: { value: { type: ['string', 'integer', 'number', 'boolean', 'array', 'object', 'null'] } },
    };

    // The type picker comes first; a boolean's answer is a second picker.
    const typePicker = () => screen.getAllByRole('combobox')[0];

    it('offers its types, null aside, and starts on the first', async () => {
        const user = userEvent.setup({ delay: null });
        show(schema);

        expect(typePicker()).toHaveTextContent('string');
        expect(screen.getByLabelText(/^value \(string\)/)).toHaveAttribute('type', 'text');

        await user.click(typePicker());
        const offered = (await screen.findAllByRole('option')).map(option => option.textContent);
        expect(offered).toEqual(['string', 'integer', 'number', 'boolean', 'array', 'object']);
    });

    it('writes the value in the type picked', async () => {
        const user = userEvent.setup({ delay: null });
        show(schema);

        await user.type(screen.getByLabelText(/^value \(string\)/), '7');
        expect(subject()).toEqual({ id: BOB, value: '7' });

        // Picking another type empties the field.
        await pick(user, typePicker(), 'integer');
        expect(screen.getByLabelText(/^value \(integer\)/)).toHaveValue(null);
        expect(screen.getByLabelText(/^value \(integer\)/)).toHaveAttribute('type', 'number');
        expect(subject()).toEqual({ id: BOB });

        await user.type(screen.getByLabelText(/^value \(integer\)/), '7');
        expect(subject()).toEqual({ id: BOB, value: 7 });

        await pick(user, typePicker(), 'number');
        await user.type(screen.getByLabelText(/^value \(number\)/), '2.5');
        expect(subject()).toEqual({ id: BOB, value: 2.5 });

        await pick(user, typePicker(), 'boolean');
        expect(subject()).toEqual({ id: BOB });
        await pick(user, screen.getAllByRole('combobox')[1], 'True');
        expect(subject()).toEqual({ id: BOB, value: true });

        await pick(user, typePicker(), 'array');
        expect(screen.getByText('Enter a JSON array')).toBeInTheDocument();
        await paste(user, screen.getByLabelText(/^value \(array\)/), '{}');
        expect(screen.getByText('Must be a JSON array')).toBeInTheDocument();
        await paste(user, screen.getByLabelText(/^value \(array\)/), '[1]');
        expect(subject()).toEqual({ id: BOB, value: [1] });

        await pick(user, typePicker(), 'object');
        expect(screen.getByText('Enter a JSON object')).toBeInTheDocument();
        await paste(user, screen.getByLabelText(/^value \(object\)/), '{"a": 1}');
        expect(subject()).toEqual({ id: BOB, value: { a: 1 } });
    });

    it('is checked as the type picked', async () => {
        const user = userEvent.setup({ delay: null });
        show({ properties: { value: { type: ['integer', 'boolean'] } }, required: ['value'] });

        expect(screen.getByLabelText(/^value \(integer\)/)).toBeRequired();
        expect(screen.getByText('This field is required')).toBeInTheDocument();

        await user.type(screen.getByLabelText(/^value \(integer\)/), '1.5');
        expect(screen.getByText('Must be an integer')).toBeInTheDocument();

        await pick(user, typePicker(), 'boolean');
        expect(screen.getByText('This field is required')).toBeInTheDocument();
        expect(screen.queryByText('Must be an integer')).toBeNull();

        await pick(user, screen.getAllByRole('combobox')[1], 'False');
        expect(screen.queryByText('This field is required')).toBeNull();
        expect(subject()).toEqual({ id: BOB, value: false });
    });
});
