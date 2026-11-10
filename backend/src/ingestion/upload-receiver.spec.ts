import { HttpException } from '@nestjs/common';
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_CONCURRENT_UPLOADS_PER_USER,
  UploadSlots,
} from './upload-receiver.js';

describe('UploadSlots', () => {
  it('limits concurrent uploads per user and releases idempotently', () => {
    const slots = new UploadSlots();
    const releases = Array.from(
      { length: MAX_CONCURRENT_UPLOADS_PER_USER },
      () => slots.acquire('laura'),
    );
    expect(() => slots.acquire('laura')).toThrow(HttpException);
    // Otro usuario no se ve afectado.
    const andres = slots.acquire('andres');
    releases[0]!();
    releases[0]!(); // liberar dos veces no libera otro cupo
    const again = slots.acquire('laura');
    expect(() => slots.acquire('laura')).toThrow(HttpException);
    [again, releases[1]!, andres].forEach((release) => release());
  });

  it('limits total concurrent uploads with 429', () => {
    const slots = new UploadSlots();
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i++) slots.acquire(`user-${i}`);
    try {
      slots.acquire('one-more');
      expect.unreachable();
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });
});
