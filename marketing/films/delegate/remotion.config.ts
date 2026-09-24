import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("png");
Config.setCodec("h264");
Config.setPixelFormat("yuv420p");
Config.setCrf(14);
Config.setOverwriteOutput(true);
// The smallest render target has one quota-bound CPU despite reporting four
// logical cores to Node; one worker remains portable across both environments.
Config.setConcurrency(1);
