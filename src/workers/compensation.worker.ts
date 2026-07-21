import { createCompensationWorkerRuntime } from "./compensationWorkerRuntime";

interface ModuleWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as ModuleWorkerScope;
const runtime = createCompensationWorkerRuntime({
  emit: (response, transfer) => workerScope.postMessage(response, Array.from(transfer ?? [])),
});

workerScope.onmessage = (event) => runtime.dispatch(event.data);
