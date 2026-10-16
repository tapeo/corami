import { connect } from 'node:net';

export const PORT_RANGE_START = 4100;
export const PORT_RANGE_END = 4999;
export const DAEMON_PORT = 7420;

export function isPortResponding(port: number): Promise<boolean> {
  return probe(port);
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
