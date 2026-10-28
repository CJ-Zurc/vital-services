import unittest
from app.context import assertion
from app.clustering import distance

class ContextTests(unittest.TestCase):
    def detect(self,text,phrase):
        start=text.index(phrase)
        return assertion(text,start,start+len(phrase))
    def test_negation_and_contrast(self):
        self.assertEqual(self.detect('No fever but headache','fever'),'denied')
        self.assertEqual(self.detect('No fever but headache','headache'),'present')
    def test_uncertainty_and_other_person(self):
        self.assertEqual(self.detect('Not sure about fever','fever'),'uncertain')
        self.assertEqual(self.detect('My mother has asthma','asthma'),'other_person')
    def test_history_and_hypothetical(self):
        self.assertEqual(self.detect('History of headache','headache'),'historical')
        self.assertEqual(self.detect('If fever occurs','fever'),'unresolved')
    def test_post_negation(self):self.assertEqual(self.detect('Fever absent','Fever'),'denied')

class DistanceTests(unittest.TestCase):
    def setUp(self):self.a={'symptoms':[{'id':'a','name':'A'}],'severity':0,'onset':'UNKNOWN','region':None,'quality':[],'timing':'UNKNOWN'}
    def test_missing_components_and_identical(self):self.assertEqual(distance(self.a,self.a),0)
    def test_no_shared_positive_symptom(self):self.assertEqual(distance(self.a,{**self.a,'symptoms':[{'id':'b'}]}),1)
    def test_symptoms_dominate_severity(self):self.assertLess(distance(self.a,{**self.a,'severity':10}),.1)
    def test_symmetric_distance(self):
        b={**self.a,'quality':['Aching'],'severity':8}
        self.assertEqual(distance(self.a,b),distance(b,self.a))
    def test_dbscan_and_cohort_separation(self):
        try:import sklearn
        except ImportError:self.skipTest('Install locked NLP dependencies to exercise DBSCAN')
        from app.clustering import cluster
        rows=[{'id':str(i),'features':{**self.a,'cohort':'adult'}} for i in range(5)]
        result=cluster(rows);self.assertEqual(result['clusters'][0]['count'],5)
        self.assertEqual(cluster(rows),result)
        self.assertEqual(result['cohorts'][1]['status'],'insufficient_data')

if __name__=='__main__':unittest.main()
