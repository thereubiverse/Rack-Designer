import type { SupabaseClient } from "@supabase/supabase-js";
import { getDefaultOrganization } from "@/features/locations/repository";
import { emptyFace, type Face } from "@/domain/faceplate";

export interface BrandRow { id: string; organization_id: string; name: string; created_at: string; }
export interface DeviceTypeRow { id: string; organization_id: string; name: string; created_at: string; }
export interface DeviceTemplateRow {
  id: string; organization_id: string; name: string;
  brand_id: string | null; device_type_id: string;
  rack_units: number; width_in: number; rack_mounted: boolean;
  front_face: unknown | null; back_face: unknown | null;
  created_at: string; updated_at: string;
}
export interface DeviceTemplateListRow {
  id: string; name: string; brandName: string | null; typeName: string;
  rackUnits: number; widthIn: number; rackMounted: boolean;
}

export async function listDeviceTypes(db: SupabaseClient): Promise<DeviceTypeRow[]> {
  const { data, error } = await db.from("device_types").select("*").order("name");
  if (error) throw new Error(`listDeviceTypes: ${error.message}`);
  return data as DeviceTypeRow[];
}

export async function createDeviceType(db: SupabaseClient, input: { name: string }): Promise<DeviceTypeRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("device_types")
    .insert({ organization_id: org.id, name: input.name }).select("*").single();
  if (error) throw new Error(`createDeviceType: ${error.message}`);
  return data as DeviceTypeRow;
}

export async function deleteDeviceType(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("device_types").delete().eq("id", id);
  if (error) throw new Error(`deleteDeviceType: ${error.message}`);
}

export async function listBrands(db: SupabaseClient): Promise<BrandRow[]> {
  const { data, error } = await db.from("brands").select("*").order("name");
  if (error) throw new Error(`listBrands: ${error.message}`);
  return data as BrandRow[];
}

export async function createBrand(db: SupabaseClient, input: { name: string }): Promise<BrandRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("brands")
    .insert({ organization_id: org.id, name: input.name }).select("*").single();
  if (error) throw new Error(`createBrand: ${error.message}`);
  return data as BrandRow;
}

interface TemplateJoinRow {
  id: string; name: string; rack_units: number; width_in: number; rack_mounted: boolean;
  brands: { name: string } | null;
  device_types: { name: string };
}

export async function listDeviceTemplates(db: SupabaseClient): Promise<DeviceTemplateListRow[]> {
  const { data, error } = await db.from("device_templates")
    .select("id, name, rack_units, width_in, rack_mounted, brands(name), device_types!inner(name)")
    .order("name");
  if (error) throw new Error(`listDeviceTemplates: ${error.message}`);
  const rows = (data ?? []) as unknown as TemplateJoinRow[];
  return rows.map((r) => ({
    id: r.id, name: r.name,
    brandName: r.brands ? r.brands.name : null,
    typeName: r.device_types.name,
    rackUnits: r.rack_units, widthIn: r.width_in, rackMounted: r.rack_mounted,
  }));
}

export async function createDeviceTemplate(
  db: SupabaseClient,
  input: { name: string; deviceTypeId: string; brandId?: string; rackUnits?: number; widthIn?: number; rackMounted?: boolean; frontFace?: Face; backFace?: Face },
): Promise<DeviceTemplateRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("device_templates").insert({
    organization_id: org.id,
    name: input.name,
    device_type_id: input.deviceTypeId,
    brand_id: input.brandId ?? null,
    rack_units: input.rackUnits ?? 1,
    width_in: input.widthIn ?? 19,
    rack_mounted: input.rackMounted ?? true,
    front_face: input.frontFace ?? emptyFace(),
    back_face: input.backFace ?? emptyFace(),
  }).select("*").single();
  if (error) throw new Error(`createDeviceTemplate: ${error.message}`);
  return data as DeviceTemplateRow;
}

export async function deleteDeviceTemplate(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("device_templates").delete().eq("id", id);
  if (error) throw new Error(`deleteDeviceTemplate: ${error.message}`);
}

export async function getDeviceTemplate(
  db: SupabaseClient, id: string,
): Promise<DeviceTemplateRow | null> {
  const { data, error } = await db.from("device_templates")
    .select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getDeviceTemplate: ${error.message}`);
  return (data as DeviceTemplateRow | null) ?? null;
}

export async function updateDeviceTemplate(
  db: SupabaseClient, id: string,
  input: {
    name: string; deviceTypeId: string; brandId: string | null;
    rackUnits: number; widthIn: number; rackMounted: boolean;
    frontFace: Face; backFace: Face;
  },
): Promise<DeviceTemplateRow> {
  const { data, error } = await db.from("device_templates").update({
    name: input.name,
    device_type_id: input.deviceTypeId,
    brand_id: input.brandId,
    rack_units: input.rackUnits,
    width_in: input.widthIn,
    rack_mounted: input.rackMounted,
    front_face: input.frontFace,
    back_face: input.backFace,
    updated_at: new Date().toISOString(),
  }).eq("id", id).select("*").single();
  if (error) throw new Error(`updateDeviceTemplate: ${error.message}`);
  return data as DeviceTemplateRow;
}

export interface EditableTemplate {
  id: string; name: string; brandId: string | null; deviceTypeId: string;
  rackUnits: number; widthIn: number; rackMounted: boolean;
  frontFace: Face; backFace: Face;
}

export function toEditableTemplate(row: DeviceTemplateRow): EditableTemplate {
  return {
    id: row.id,
    name: row.name,
    brandId: row.brand_id,
    deviceTypeId: row.device_type_id,
    rackUnits: row.rack_units,
    widthIn: row.width_in,
    rackMounted: row.rack_mounted,
    frontFace: (row.front_face as Face | null) ?? emptyFace(),
    backFace: (row.back_face as Face | null) ?? emptyFace(),
  };
}
