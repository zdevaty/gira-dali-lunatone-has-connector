// What drivers and sensors report about themselves: energy and diagnostics
// (DALI parts 252 and 253) and DALI-2 sensor values, kept from the last
// reading and published into Home Assistant when the status sensors are on.
//
// A diagnostics read puts queries on the bus, so it happens when a person
// presses the button -- or, only if `diagnostics_interval_hours` is set, on
// that schedule. A scheduled read never competes with a person: it waits while
// a knob has been used in the last couple of minutes or the app is already
// busy on the bus, and reads one driver at a time with a pause in between.
//
// Sensor values are read with a GET, from what the gateway already holds.

import { monotonicNow } from './clock.js';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Device classes Home Assistant knows, for the sensor types the gateway
// reports. Units come from the gateway where it gives one.
const SENSOR_CLASSES = {
  temperature: { device_class: 'temperature', unit: '°C' },
  airHumidity: { device_class: 'humidity', unit: '%' },
  airPressure: { device_class: 'atmospheric_pressure', unit: 'hPa' },
  eCO2: { device_class: 'carbon_dioxide', unit: 'ppm' },
  VOC: { device_class: 'volatile_organic_compounds_parts', unit: 'ppb' },
  airQuality: { device_class: 'aqi', unit: null },
  light: { device_class: 'illuminance', unit: 'lx' },
};

const FAILURE_FLAGS = [
  'controlGearOverallFailureCondition', 'controlGearExternalSupplyUndervoltage', 'controlGearExternalSupplyOvervoltage',
  'controlGearOutputPowerLimitation', 'controlGearThermalDerating', 'controlGearThermalShutdown',
  'lightSourceOverallFailureCondition', 'lightSourceShortCircuit', 'lightSourceOpenCircuit',
  'lightSourceThermalDerating', 'lightSourceThermalShutdown',
];

export function summariseDiagnostics(reading) {
  const e = reading?.energy?.data ?? null;
  const d = reading?.diagnostics?.data ?? null;
  const hours = (s) => (typeof s === 'number' ? Math.round(s / 360) / 10 : null);
  const flags = d ? FAILURE_FLAGS.filter((k) => d[k] === true) : [];
  const onHours = hours(d?.lightSourceOnTimeSeconds);
  const rated = typeof d?.ratedMedianUsefulLifeOfLuminaireHours === 'number' && d.ratedMedianUsefulLifeOfLuminaireHours > 0
    ? d.ratedMedianUsefulLifeOfLuminaireHours : null;
  return {
    energy_supported: reading?.energy?.supported ?? null,
    diagnostics_supported: reading?.diagnostics?.supported ?? null,
    energy_kwh: typeof e?.activeEnergyWattHours === 'number' ? Math.round(e.activeEnergyWattHours) / 1000 : null,
    power_w: typeof e?.activePowerWatt === 'number' ? e.activePowerWatt : null,
    gear_temperature_c: typeof d?.controlGearTemperatureCelsius === 'number' ? d.controlGearTemperatureCelsius : null,
    light_source_temperature_c: typeof d?.lightSourceTemperatureCelsius === 'number' ? d.lightSourceTemperatureCelsius : null,
    gear_operating_hours: hours(d?.controlGearOperatingTimeSeconds),
    light_on_hours: onHours,
    light_starts: d?.lightSourceStartCounter ?? null,
    rated_life_hours: rated,
    life_used_percent: rated && onHours != null ? Math.round((onHours / rated) * 1000) / 10 : null,
    supply_voltage: d?.controlGearExternalSupplyVoltageVoltRms ?? null,
    power_factor: d?.controlGearPowerFactor ?? null,
    failures: flags,
  };
}

export function createGatewayTelemetry({
  admin,
  reader,
  log = () => {},
  intervalHours = 0,
  // Only when something consumes the values: the HA status sensors.
  pollSensors = false,
  sensorsEveryMs = 60_000,
  // A knob used this recently holds a scheduled read back.
  quietMs = 120_000,
  pauseMs = 5000,
  retryMs = 30_000,
  lastGestureAt = () => null,
  onChange = () => {},
  now = monotonicNow,
  wall = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!admin || !reader) throw new Error('createGatewayTelemetry requires admin and reader');
  const readings = new Map(); // device id -> { at, device, energy, diagnostics }
  let sensors = { at: null, list: [] };
  let devices = [];
  let scheduleTimer = null;
  let sensorsTimer = null;
  let stopped = false;
  let lastScheduled = null;

  const sleep = (ms) => new Promise((resolve) => { const t = setTimer(resolve, ms); t?.unref?.(); });

  async function refreshDevices() {
    const r = await reader.devices();
    if (r.ok) devices = r.value;
    return devices;
  }

  async function read(id, { scheduled = false } = {}) {
    const r = await admin.readDiagnostics(id, { scheduled });
    if (r.ok) {
      await refreshDevices();
      const device = devices.find((d) => d.id === id) ?? { id };
      readings.set(id, { at: new Date(wall()).toISOString(), device: { id, name: device.name ?? '', address: device.address ?? null, line: device.line ?? 0 },
        energy: r.energy, diagnostics: r.diagnostics });
      const s = summariseDiagnostics(r);
      if (s.failures.length) {
        log({ kind: 'alert', alert: 'driver_reports_failure', id, address: device.address ?? null, name: device.name ?? '', failures: s.failures });
      }
      try { onChange(); } catch { /* publishing is best effort */ }
    }
    return r;
  }

  // One pass over every driver. Returns early, and is retried, when the bus is
  // busy or a knob was just used.
  async function scheduledPass() {
    const list = (await refreshDevices()).filter((d) => d.address != null);
    let done = 0;
    let unsupported = 0;
    for (const d of list) {
      if (stopped) return;
      for (let tries = 0; ; tries++) {
        const gesture = lastGestureAt();
        const quiet = gesture === null || now() - gesture > quietMs;
        if (quiet && !admin.busy()) break;
        if (tries >= 20) return log({ kind: 'alert', alert: 'diagnostics_pass_abandoned', done, of: list.length, note: 'the bus stayed busy; tried again at the next interval' });
        await sleep(retryMs);
        if (stopped) return;
      }
      const r = await read(d.id, { scheduled: true });
      if (r.ok) done += 1;
      if (r.ok && r.energy?.supported === false && r.diagnostics?.supported === false) unsupported += 1;
      await sleep(pauseMs);
    }
    lastScheduled = { at: new Date(wall()).toISOString(), done, unsupported, of: list.length };
  }

  function scheduleNext(ms) {
    if (stopped || !(intervalHours > 0)) return;
    scheduleTimer = setTimer(async () => {
      scheduleTimer = null;
      try { await scheduledPass(); } catch { /* next interval */ }
      scheduleNext(intervalHours * 3_600_000);
    }, ms);
    scheduleTimer?.unref?.();
  }

  async function pollSensorsOnce() {
    const r = await reader.sensors({ fresh: true });
    if (r.ok) {
      const changed = JSON.stringify(r.value) !== JSON.stringify(sensors.list);
      sensors = { at: new Date(wall()).toISOString(), list: r.value };
      if (changed) { try { onChange(); } catch { /* best effort */ } }
    }
    return r;
  }

  function sensorsLoop() {
    if (stopped || !pollSensors) return;
    sensorsTimer = setTimer(async () => {
      sensorsTimer = null;
      await pollSensorsOnce().catch(() => {});
      sensorsLoop();
    }, sensorsEveryMs);
    sensorsTimer?.unref?.();
  }

  // Entities for Home Assistant. Named by line and address, which is what a
  // person sees on the Devices page; the gateway's name is the friendly name.
  function haStates() {
    const out = [];
    for (const r of readings.values()) {
      const s = summariseDiagnostics(r);
      const base = `dali_bridge_l${r.device.line ?? 0}_a${r.device.address ?? `id${r.device.id}`}`;
      const name = r.device.name || `DALI A${r.device.address}`;
      const common = { read_at: r.at };
      if (s.energy_kwh != null) {
        out.push({ entity_id: `sensor.${base}_energy`, state: s.energy_kwh,
          attributes: { friendly_name: `${name} energy`, device_class: 'energy', state_class: 'total_increasing', unit_of_measurement: 'kWh', ...common } });
      }
      if (s.power_w != null) {
        out.push({ entity_id: `sensor.${base}_power`, state: s.power_w,
          attributes: { friendly_name: `${name} power`, device_class: 'power', state_class: 'measurement', unit_of_measurement: 'W', ...common } });
      }
      if (s.gear_temperature_c != null) {
        out.push({ entity_id: `sensor.${base}_temperature`, state: s.gear_temperature_c,
          attributes: { friendly_name: `${name} driver temperature`, device_class: 'temperature', state_class: 'measurement', unit_of_measurement: '°C', ...common } });
      }
      if (s.light_on_hours != null) {
        out.push({ entity_id: `sensor.${base}_light_hours`, state: s.light_on_hours,
          attributes: { friendly_name: `${name} lamp hours`, icon: 'mdi:timer-outline', state_class: 'total_increasing', unit_of_measurement: 'h',
            rated_life_hours: s.rated_life_hours, life_used_percent: s.life_used_percent, starts: s.light_starts, ...common } });
      }
      if (s.diagnostics_supported) {
        out.push({ entity_id: `binary_sensor.${base}_problem`, state: s.failures.length ? 'on' : 'off',
          attributes: { friendly_name: `${name} problem`, device_class: 'problem', failures: s.failures, ...common } });
      }
    }
    for (const sensor of sensors.list) {
      const id = `dali_bridge_sensor_${slug(sensor.id)}`;
      const name = sensor.name || `DALI sensor ${sensor.id}`;
      const attrs = { friendly_name: name, reported_at: sensor.timestamp ?? null,
        dali: sensor.daliSensorAddress ?? null, source: sensor.addressType ?? null };
      if (sensor.type === 'occupancy') {
        out.push({ entity_id: `binary_sensor.${id}`, state: sensor.value > 0 ? 'on' : 'off', attributes: { ...attrs, device_class: 'occupancy' } });
        continue;
      }
      const cls = SENSOR_CLASSES[sensor.type] ?? { device_class: null, unit: null };
      const unit = sensor.unit || cls.unit;
      out.push({ entity_id: `sensor.${id}`, state: sensor.value ?? 'unknown', attributes: {
        ...attrs, state_class: 'measurement',
        ...(cls.device_class ? { device_class: cls.device_class } : {}),
        ...(unit ? { unit_of_measurement: unit } : {}),
      } });
    }
    return out;
  }

  return {
    read,
    pollSensorsOnce,
    haStates,
    readings: () => [...readings.values()].map((r) => ({ ...r, summary: summariseDiagnostics(r) })),
    sensors: () => sensors,
    snapshot: () => ({ interval_hours: intervalHours, last_scheduled: lastScheduled, readings: readings.size, sensors: sensors.list.length }),
    start() {
      // The first scheduled pass waits an interval's tenth, at least ten
      // minutes: a restart is not a reason to query every driver at once.
      scheduleNext(Math.max(600_000, intervalHours * 360_000));
      if (pollSensors) pollSensorsOnce().catch(() => {}).finally(sensorsLoop);
    },
    stop() {
      stopped = true;
      if (scheduleTimer) clearTimer(scheduleTimer);
      if (sensorsTimer) clearTimer(sensorsTimer);
    },
  };
}
