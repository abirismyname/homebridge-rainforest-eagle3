import { PlatformConfig } from 'homebridge';

export const PLATFORM_NAME = 'EAGLE';
export const PLUGIN_NAME = 'homebridge-rainforest-eagle3-abirismyname';

export interface EAGLEConfig extends PlatformConfig {
  host?: string;
  cloudId: string;
  installCode: string;
  pollInterval?: number;
  meterName?: string;
  showExportMeter?: boolean;
  exportMeterName?: string;
  matter?: boolean;
}
