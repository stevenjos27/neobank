/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import 'dotenv/config';
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const swaggerConfig = new DocumentBuilder()
    .setTitle('NeoBank API')
    .setDescription('REST API for accounts, transfers and auth')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(
    `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap();
