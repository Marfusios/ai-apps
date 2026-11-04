import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreC2, type C2Dataset } from '../../evals/search-quality/part5/field-score.js';
import type { FieldObservation } from '../../evals/search-quality/types.js';

const dataset=JSON.parse(readFileSync('evals/search-quality/part5/frozen/fields.json','utf8')) as C2Dataset;
const ideal=():FieldObservation[]=>dataset.questions.map(q=>({id:q.id,output:{intent:'case_search',filters:q.gold,terms:'historical investigations'},
  error:null,usage:null,elapsedMs:1,reservationId:`synthetic-${q.id}`,chargedUsd:0} as FieldObservation));

describe('C2 complete exact-field decision, no paid fixtures',()=>{
  it('requires the full sample and at least 295 correct nonempty emissions per field',()=>{
    const observations=ideal();
    const full=scoreC2(dataset,observations);
    expect(full.clears).toEqual({yearRange:true,category:true});
    expect(full.guarded.yearRange).toMatchObject({tp:400,fp:0,fn:0});
    expect(full.guarded.category).toMatchObject({tp:400,fp:0,fn:0});
    expect(scoreC2(dataset,observations.slice(1)).clears).toEqual({yearRange:false,category:false});
    let omissions=0;
    for(const o of observations)if(dataset.questions.find(q=>q.id===o.id)?.field==='category' && (o.output?.filters.category?.length??0)>0 && omissions++<106)o.output={intent:'case_search',filters:{},terms:'investigations'};
    const sparse=scoreC2(dataset,observations);
    expect(sparse.guarded.category.tp).toBe(294);expect(sparse.clears.category).toBe(false);
  });
  it('scores a wrong partial range as raw FP and FN, then guarded omission',()=>{
    const observations=ideal();
    const q=dataset.questions.find(q=>q.field==='yearRange' && q.stratum==='single')!;
    const o=observations.find(o=>o.id===q.id)!;
    o.output={intent:'case_search',filters:{yearFrom:q.gold.yearFrom as number},terms:'investigations'};
    const r=scoreC2(dataset,observations);
    expect(r.raw.yearRange).toMatchObject({tp:399,fp:1,fn:1});
    expect(r.guarded.yearRange).toMatchObject({tp:399,fp:0,fn:1});
  });
  it('one erroneous applied field on the OTHER field sample fails clearance',()=>{
    const data=structuredClone(dataset),observations=ideal();
    const q=data.questions.find(q=>q.field==='category' && q.role==='control')!;
    q.question='Find accidents in 2019.'; // Synthetic erroneous no-apply gold tests the cross-field audit.
    observations.find(o=>o.id===q.id)!.output={intent:'case_search',filters:{yearFrom:2019,yearTo:2019},terms:'investigations'};
    const r=scoreC2(data,observations);
    expect(r.guarded.yearRange.fp).toBe(1);expect(r.guarded.yearRange.errors[0]!.auxiliary).toBe(true);
    expect(r.clears.yearRange).toBe(false);
  });
  it('scope failures stay in denominators and cannot be replaced by repeats',()=>{
    const observations=ideal();let count=0;
    for(const o of observations)if(dataset.questions.find(q=>q.id===o.id)?.field==='yearRange' && count++<41){o.error='invalid_output';o.output=null;}
    const r=scoreC2(dataset,observations);
    expect(r.guarded.yearRange.failures).toBe(41);expect(r.clears.yearRange).toBe(false);
    expect(()=>scoreC2(dataset,[...observations,observations[0]!])).toThrow('Duplicate');
  });
});
