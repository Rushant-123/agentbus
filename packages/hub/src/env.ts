export type Env = {
  INBOX: DurableObjectNamespace;
  SPACE: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  TESTNET: string;
  RECIPIENT: string;
  STRANGER_FREE_PER_DAY: string;
  MPP_SECRET_KEY?: string;
};
