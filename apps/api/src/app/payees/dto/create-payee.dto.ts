import { VerifyPayeeDto } from "./verify-payee.dto";

/**
 * Deliberately identical to VerifyPayeeDto — and deliberately NOT accepting a
 * name. The stored payee name is the one the bank confirmed, never one the
 * client supplied. That is what makes the payee list trustworthy enough for
 * the Phase 3 assistant to answer "how much did I send to XYZ?".
 */
export class CreatePayeeDto extends VerifyPayeeDto { }
