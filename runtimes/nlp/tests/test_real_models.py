"""Build-time smoke checks with real offline assets, independent of dictionary-build aliases."""
import os
import unittest

@unittest.skipUnless(os.environ.get('VITAL_AI_REAL_MODEL_TESTS')=='1','Real model assets required')
class RealModelTests(unittest.TestCase):
    def analyze(self,text,**fields):
        from app.inference import analyze
        return analyze({'primarySymptom':{'id':None,'name':'Other / not sure'},'chiefComplaint':text,'opqrst':fields},False)
    def test_exact_symptom(self):
        result=self.analyze('Headache')
        self.assertTrue(any(c['id']=='25064002' and c['assertion']=='present' for c in result['concepts']))
    def test_negation(self):
        result=self.analyze('No fever.')
        self.assertTrue(any(c['id']=='386661006' and c['assertion']=='denied' for c in result['concepts']))
        self.assertFalse(any(c['id']=='386661006' and c['assertion']=='present' for c in result['concepts']))
    def test_fields_do_not_share_negation(self):
        result=self.analyze('No fever.',associatedSymptoms='Cough')
        self.assertTrue(any(c['id']=='49727002' and c['assertion']=='present' for c in result['concepts']))
    def test_family_and_uncertainty(self):
        for text,expected in [('My mother has headache.','other_person'),('Not sure about fever.','uncertain')]:
            with self.subTest(text=text):
                result=self.analyze(text)
                self.assertTrue(any(c['assertion']==expected for c in result['concepts']))
    def test_confirmed_concepts_replace_extractions_without_candidates(self):
        from app.inference import analyze
        result=analyze({'primarySymptom':{'id':None,'name':'Other / not sure'},'chiefComplaint':'Headache','opqrst':{}},True,[])
        self.assertEqual(result['concepts'],[])
        self.assertEqual(result['candidates'],[])
    def test_analytics_omits_graph_and_raw_text(self):
        result=self.analyze('Cough')
        self.assertEqual(result['candidates'],[])
        self.assertNotIn('chiefComplaint',result)
        self.assertNotIn('directConditionPaths',result)

if __name__=='__main__':unittest.main()
