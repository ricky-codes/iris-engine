/**
 * Um valor fixo, ou uma função que o lê de novo em cada uso. Serve as definições que se mudam
 * pela API de administração sem reiniciar (ver src/settings/settings.ts).
 */
export type Live<T> = T | (() => T);

export const read = <T>(value: Live<T>): T =>
  typeof value === 'function' ? (value as () => T)() : value;
