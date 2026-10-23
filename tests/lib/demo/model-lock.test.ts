import {describe,it,expect,vi,afterEach} from "vitest";
import {demoModelLock} from "@/lib/demo/model-lock";
afterEach(()=>vi.unstubAllEnvs());
describe("fixed model policy",()=>{
  it.each(["local","github","demo"])("pins the same middle thinking tier in %s",storage=>{
    vi.stubEnv("STORAGE",storage);vi.stubEnv("DEMO_MODEL","retired-model");vi.stubEnv("DEMO_EFFORT","low");
    expect(demoModelLock()).toEqual({model:"deepseek-flash",thinking:true,effort:"high"});
  });
});
