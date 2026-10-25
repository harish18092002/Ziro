import { Module } from '@nestjs/common';
import { RazorpayController } from './razorpay.controller.js';
import { RazorpaySourceFactory } from './razorpay.factory.js';

export { RazorpaySourceFactory };

@Module({
  controllers: [RazorpayController],
  providers: [RazorpaySourceFactory],
  exports: [RazorpaySourceFactory],
})
export class RazorpayModule {}
