import numpy as np
import pytest
from app.local_tagger import LocalClipTagger,VOCABULARY


def tagger():
    instance=LocalClipTagger.__new__(LocalClipTagger)
    instance.candidates=[(k,v) for k,values in VOCABULARY.items() for v in values]
    return instance


def test_low_similarities_do_not_force_a_tag():
    model=tagger(); result=model.result_from_scores(np.zeros((2,len(model.candidates))))
    assert result.tags == []
    assert len(result.frame_descriptions)==2


def test_evidence_only_cites_matching_frames():
    model=tagger(); scores=np.zeros((3,len(model.candidates)))
    index=model.candidates.index(('object','bed')); scores[1,index]=.4
    result=model.result_from_scores(scores)
    assert result.tags[0].label=='bed' and result.tags[0].frame_indices==[1]
    assert 'candidate' in result.frame_descriptions[1].description


def test_invalid_scores_fail():
    model=tagger()
    with pytest.raises(ValueError): model.result_from_scores([[float('nan')]*len(model.candidates)])
