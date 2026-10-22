/**
 * The Razorpay probe talks to a real account, so it does nothing unless the person running it says
 * so explicitly. Kept separate from the script so it can be tested without running the script.
 */
export const CONFIRM_FLAG = '--confirm';

export const isConfirmed = (argv: readonly string[]): boolean => argv.includes(CONFIRM_FLAG);

export const NOT_CONFIRMED_MESSAGE = [
  'razorpay:probe sends 6 read-only GET requests to your Razorpay TEST account (one record each,',
  'nothing printed or stored). It has NOT run. To run it:',
  '',
  `    npm run razorpay:probe -w @ziro/api -- ${CONFIRM_FLAG}`,
].join('\n');
