import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
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
});
