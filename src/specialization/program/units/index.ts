// Atomic specialization units. Function is the only unit kind — see
// ../../publication.ts for the OSR-impossibility constraint that pins
// this. Sub-function code replacement requires runtime work neither
// backend supports today.

export * from "./function";
