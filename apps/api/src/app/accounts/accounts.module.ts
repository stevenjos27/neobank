import { Module } from "@nestjs/common";
import { AccountsController } from "./accounts.controller";
import { AccountsService } from "./accounts.service";
import { PayeesModule } from "../payees/payees.module";

@Module({
  imports: [PayeesModule],
  controllers: [AccountsController],
  providers: [AccountsService]
})

export class AccountsModule { }
