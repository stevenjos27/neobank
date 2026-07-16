import { Test } from '@nestjs/testing';
import { AppService } from './app.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AppService', () => {
  let service: AppService;

  beforeAll(async () => {
    const app = await Test.createTestingModule({
      providers: [
        AppService,
        { provide: PrismaService, useValue: { $queryRaw: jest.fn().mockResolvedValue([1]) } },
      ],
    }).compile();

    service = app.get<AppService>(AppService);
  });

  describe('getData', () => {
    it('should return "Hello API"', () => {
      expect(service.getData()).toEqual({ message: 'Hello API' });
    });
  });

  describe('getHealth', () => {
    it('should report healthy status', async () => {
      const result = await service.getHealth();
      expect(result.status).toEqual('ok');
      expect(result.db).toEqual('up');
      expect(result.uptime).toBeGreaterThan(0);
    });
  });
});
