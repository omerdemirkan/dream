using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .gateway),
    (name = "internet", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true)))
  ],
  sockets = [ (name = "http", address = "127.0.0.1:18795", http = (), service = "main") ]
);

const gateway :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "dist/worker.js") ],
  compatibilityDate = "2026-10-01",
  globalOutbound = "internet",
  durableObjectNamespaces = [ (className = "CallDO", uniqueKey = "workerd-check-calls") ],
  durableObjectStorage = (inMemory = void),
  bindings = [ (name = "CALLS", durableObjectNamespace = "CallDO") ]
);
