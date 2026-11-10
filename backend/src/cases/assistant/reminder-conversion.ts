/**
 * §19.6: la conversión «día absoluto del aviso → días antes» la hace el
 * backend, no Gemini. «Vence el 15, avísame el 7» → 15 − 7 = 8 días antes.
 * Si el día del aviso cae en el mes anterior (p. ej. vence el 5, avísame el
 * 28), se aproxima con un mes de 31 días: suficiente para un aviso, nunca
 * para una fecha de vencimiento real.
 */
export function reminderDaysBeforeFromAbsoluteDay(
  dueDay: number,
  reminderDay: number,
): number {
  const diff = dueDay - reminderDay;
  return diff >= 0 ? diff : diff + 31;
}
