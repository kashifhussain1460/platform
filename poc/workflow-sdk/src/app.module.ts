/** POC ONLY — NOT PRODUCTION. */
import { Module } from '@nestjs/common';
import { WorkflowModule } from '@workflow/nest';
import { PocController } from './poc.controller';

@Module({
  imports: [
    WorkflowModule.forRoot({
      // Orlixa's api compiles to CommonJS, so the POC does too — testing the
      // ESM happy path would not tell us whether Orlixa can adopt this.
      moduleType: 'commonjs',
      distDir: 'dist',
      dirs: ['src'],
    }),
  ],
  controllers: [PocController],
})
export class AppModule {}
