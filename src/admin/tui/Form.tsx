import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Validator } from '../validation.js';
import { colorProps } from './format.js';

interface BaseField {
  name: string;
  label: string;
  hint?: string;
}
export interface TextField extends BaseField {
  kind: 'text';
  initial?: string;
  optional?: boolean;
  validate?: Validator;
}
export interface SelectField extends BaseField {
  kind: 'select';
  options: { value: string; label: string }[];
  initial?: string;
}
export interface ToggleField extends BaseField {
  kind: 'toggle';
  initial?: boolean;
}
export type FieldDef = TextField | SelectField | ToggleField;

export type FormValues = Record<string, string>;

interface FormProps {
  title: string;
  fields: FieldDef[];
  submitLabel: string;
  /** Pode lançar erro: a mensagem aparece no fim do formulário e o formulário fica aberto. */
  onSubmit: (values: FormValues) => Promise<void>;
  onCancel: () => void;
}

function initialValue(field: FieldDef): string {
  switch (field.kind) {
    case 'text':
      return field.initial ?? '';
    case 'select':
      return field.initial ?? field.options[0]?.value ?? '';
    case 'toggle':
      return field.initial === true ? 'true' : 'false';
  }
}

function fieldError(field: FieldDef, value: string): string | undefined {
  switch (field.kind) {
    case 'text':
      if (value.trim() === '') return field.optional === true ? undefined : 'Obrigatório.';
      return field.validate?.(value);
    case 'select':
      return field.options.length === 0 ? 'Não há opções disponíveis.' : undefined;
    case 'toggle':
      return undefined;
  }
}

export function Form({ title, fields, submitLabel, onSubmit, onCancel }: FormProps) {
  const [values, setValues] = useState<FormValues>(() =>
    Object.fromEntries(fields.map((f) => [f.name, initialValue(f)])),
  );
  const [cursors, setCursors] = useState<Record<string, number>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, initialValue(f).length])),
  );
  const [focus, setFocus] = useState(0);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const [submitError, setSubmitError] = useState<string | undefined>();

  const current = fields[focus];

  const setValue = (name: string, value: string, cursor: number): void => {
    setValues((v) => ({ ...v, [name]: value }));
    setCursors((c) => ({ ...c, [name]: cursor }));
    setSubmitError(undefined);
  };

  const errorOf = (field: FieldDef): string | undefined =>
    fieldError(field, values[field.name] ?? '');

  const moveTo = (index: number): void => {
    if (current) setTouched((t) => new Set(t).add(current.name));
    setFocus(Math.min(Math.max(0, index), fields.length - 1));
  };

  const submit = (): void => {
    const firstInvalid = fields.findIndex((f) => errorOf(f) !== undefined);
    if (firstInvalid >= 0) {
      setTouched(new Set(fields.map((f) => f.name)));
      setFocus(firstInvalid);
      return;
    }
    busy.current = true;
    setSubmitting(true);
    setSubmitError(undefined);
    onSubmit(values).catch((err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : String(err));
      busy.current = false;
      setSubmitting(false);
    });
  };

  // Sempre ativo (ver App): enquanto grava, as teclas são ignoradas aqui dentro.
  useInput((input, key) => {
    if (busy.current) return;
    if (key.escape) return onCancel();
    if (key.ctrl && input === 's') return submit();
    if (key.tab && key.shift) return moveTo(focus - 1);
    if (key.tab || key.downArrow) return moveTo(focus + 1);
    if (key.upArrow) return moveTo(focus - 1);
    if (key.return) return focus === fields.length - 1 ? submit() : moveTo(focus + 1);
    if (!current) return;

    const value = values[current.name] ?? '';

    if (current.kind === 'select') {
      const count = current.options.length;
      if (count === 0) return;
      const at = Math.max(
        0,
        current.options.findIndex((o) => o.value === value),
      );
      const step = key.rightArrow || input === ' ' ? 1 : key.leftArrow ? -1 : 0;
      if (step !== 0)
        setValue(current.name, current.options[(at + step + count) % count]?.value ?? value, 0);
      return;
    }

    if (current.kind === 'toggle') {
      if (key.leftArrow || key.rightArrow || input === ' ') {
        setValue(current.name, value === 'true' ? 'false' : 'true', 0);
      }
      return;
    }

    // Campo de texto
    const cursor = Math.min(cursors[current.name] ?? value.length, value.length);
    if (key.leftArrow)
      return setCursors((c) => ({ ...c, [current.name]: Math.max(0, cursor - 1) }));
    if (key.rightArrow) {
      return setCursors((c) => ({ ...c, [current.name]: Math.min(value.length, cursor + 1) }));
    }
    if (key.home || (key.ctrl && input === 'a'))
      return setCursors((c) => ({ ...c, [current.name]: 0 }));
    if (key.end || (key.ctrl && input === 'e')) {
      return setCursors((c) => ({ ...c, [current.name]: value.length }));
    }
    if (key.ctrl && input === 'u') return setValue(current.name, '', 0);
    // Muitos terminais enviam "delete" para a tecla Backspace.
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      return setValue(current.name, value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
    }
    if (input && !key.ctrl && !key.meta) {
      const clean = input.replace(/[\r\n]/g, '');
      setValue(
        current.name,
        value.slice(0, cursor) + clean + value.slice(cursor),
        cursor + clean.length,
      );
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column">
        {fields.map((field, index) => {
          const focused = index === focus;
          const value = values[field.name] ?? '';
          const error = touched.has(field.name) ? errorOf(field) : undefined;
          const cursor = Math.min(cursors[field.name] ?? value.length, value.length);
          return (
            <Box key={field.name} flexDirection="column">
              <Text>
                <Text {...colorProps(focused ? 'cyan' : undefined)} bold={focused}>
                  {focused ? '› ' : '  '}
                  {field.label}
                  {field.kind === 'text' && field.optional === true ? ' (opcional)' : ''}
                  {': '}
                </Text>
                {field.kind === 'text' &&
                  (focused ? (
                    <Text>
                      {value.slice(0, cursor)}
                      <Text inverse>{value[cursor] ?? ' '}</Text>
                      {value.slice(cursor + 1)}
                    </Text>
                  ) : (
                    <Text>{value}</Text>
                  ))}
                {field.kind === 'select' && (
                  <Text {...colorProps(focused ? 'cyan' : undefined)}>
                    {field.options.length === 0
                      ? '(sem opções)'
                      : `${focused ? '‹ ' : ''}${field.options.find((o) => o.value === value)?.label ?? ''}${focused ? ' ›' : ''}`}
                  </Text>
                )}
                {field.kind === 'toggle' && (
                  <Text {...colorProps(focused ? 'cyan' : undefined)}>
                    {value === 'true' ? '[x] sim' : '[ ] não'}
                  </Text>
                )}
              </Text>
              {error !== undefined ? (
                <Text color="red">
                  {'    '}
                  {error}
                </Text>
              ) : field.hint !== undefined && focused ? (
                <Text dimColor>
                  {'    '}
                  {field.hint}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      {submitError !== undefined && <Text color="red">✗ {submitError}</Text>}
      {submitting ? (
        <Text color="yellow">A guardar…</Text>
      ) : (
        <Text dimColor>
          Enter avança · Tab/↑↓ muda de campo · ←→ escolhe · Ctrl+S ou Enter no último campo:{' '}
          {submitLabel} · Esc cancela
        </Text>
      )}
    </Box>
  );
}
