const configured = process.env.CORAMI_VERSION;

export const VERSION = configured === undefined || configured === '' ? 'dev' : configured;
