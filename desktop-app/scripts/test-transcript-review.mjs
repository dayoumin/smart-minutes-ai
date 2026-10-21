import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getTranscriptReviewIssues, normalizeReviewIssues, formatReviewTime} from '../src/transcriptReview.ts';

test('legacy merged paragraph resolves the original short review interval without rewriting storage',()=>{
 const raw=[{start:'00:01:17',end:'00:01:21',speaker:'A',text:'확인',shortSpeakerOverlap:true},{start:'00:01:21',end:'00:03:34',speaker:'A',text:'정상'}];
 const paragraph={...raw[0],end:'00:03:34',text:'확인 정상'};
 const before=JSON.stringify({raw,paragraph});
 assert.deepEqual(getTranscriptReviewIssues(paragraph,raw),[{reason:'short_speaker_overlap',start:77,end:81}]);
 assert.equal(JSON.stringify({raw,paragraph}),before);
});
test('new precise reasons survive grouping, serialization and fractional seconds',()=>{
 const paragraph={start:'00:01:00',end:'00:03:00',speaker:'A',text:'본문',reviewVersion:1,reviewIssues:[{reason:'short_speaker_overlap',start:77.76,end:78.22}]};
 assert.deepEqual(getTranscriptReviewIssues(JSON.parse(JSON.stringify(paragraph)),[]),paragraph.reviewIssues);
 assert.equal(formatReviewTime(77.76),'00:01:17.76');
});
test('explicit empty reviews suppress tiny correction provenance, UNKNOWN is never hidden',()=>{
 const segment={start:'00:00:00',end:'00:00:10',speaker:'A',text:'본문',timingApproximate:true,reviewVersion:1,reviewIssues:[]};
 assert.deepEqual(getTranscriptReviewIssues(segment,[]),[]);
 assert.deepEqual(getTranscriptReviewIssues({...segment,speaker:'UNKNOWN'},[]),[{reason:'speaker_unassigned',start:0,end:10}]);
});
test('untrusted annotations cannot inject reasons or nonfinite ranges',()=>{
 assert.deepEqual(normalizeReviewIssues([{reason:'<script>',start:0,end:1},{reason:'speaker_split',start:NaN,end:1},{reason:'speaker_split',start:3,end:2}]),[]);
});
test('legacy paragraph cannot recreate a warning explicitly suppressed in all original intervals',()=>{
 const base={start:'00:00:00',end:'00:00:30',speaker:'A',text:'본문',timingApproximate:true,reviewVersion:1,reviewIssues:[]};
 const raw=[base,{...base,start:'00:00:30',end:'00:01:00',timingApproximate:false}];
 assert.deepEqual(getTranscriptReviewIssues({...base,end:'00:01:00',reviewVersion:undefined,reviewIssues:undefined},raw),[]);
});
test('an unassigned displayed turn remains visible when older edits disagree with new original metadata',()=>{
 const row={start:'00:00:00',end:'00:00:10',speaker:'UNKNOWN',text:'수정본'};
 assert.deepEqual(getTranscriptReviewIssues(row,[{...row,speaker:'A',reviewVersion:1,reviewIssues:[]}]),[{reason:'speaker_unassigned',start:0,end:10}]);
});
