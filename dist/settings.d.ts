import { PlatformConfig } from 'homebridge';
export declare const PLATFORM_NAME = "EAGLE";
export declare const PLUGIN_NAME = "homebridge-rainforest-eagle3-abirismyname";
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
//# sourceMappingURL=settings.d.ts.map