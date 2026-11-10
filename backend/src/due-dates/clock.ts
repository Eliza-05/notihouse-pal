/** Fuente de la hora actual. Las pruebas la sustituyen para fijar la fecha. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = { now: () => new Date() };
