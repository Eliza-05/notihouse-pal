import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from '../database/database.service.js';
import { HealthController, READINESS_TIMEOUT_MS } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;
  const database = { ping: vi.fn() };

  beforeEach(async () => {
    database.ping.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DatabaseService, useValue: database }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ok status and service name', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('notihouse-pal-api');
  });

  it('returns the current time as an ISO 8601 UTC timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T19:00:00.000Z'));

    expect(controller.check().timestamp).toBe('2026-10-24T19:00:00.000Z');
  });

  it('only exposes status, service and timestamp', () => {
    expect(Object.keys(controller.check()).sort()).toEqual([
      'service',
      'status',
      'timestamp',
    ]);
  });

  it('liveness never touches the database', () => {
    controller.check();
    expect(database.ping).not.toHaveBeenCalled();
  });

  describe('readiness', () => {
    it('reports ready when PostgreSQL answers', async () => {
      database.ping.mockResolvedValue(true);
      await expect(controller.ready()).resolves.toMatchObject({
        status: 'ready',
        checks: { database: 'ok' },
      });
    });

    it('answers 503 without details when PostgreSQL fails', async () => {
      database.ping.mockRejectedValue(
        new Error('password authentication failed'),
      );
      const error = await controller.ready().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        JSON.stringify((error as ServiceUnavailableException).getResponse()),
      ).not.toContain('password');
    });

    it('answers 503 when PostgreSQL does not respond in time', async () => {
      vi.useFakeTimers();
      database.ping.mockReturnValue(new Promise(() => undefined));
      const pending = controller.ready().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
      expect(await pending).toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
