/** One Windows-safe NODE_OPTIONS entry: deny external I/O first, then mock only DeepSeek. */
require("./deny-network.cjs");
require("./dialogue-provider-fixture.cjs");
