import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PayeesController } from "./payees.controller";
import { PayeesService } from "./payees.service";

@Module({
  imports: [PrismaModule],
  controllers: [PayeesController],
  providers: [PayeesService],
  exports: [PayeesService]
})
export class PayeesModule { }
