import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as rds from "aws-cdk-lib/aws-rds"

interface DatabaseStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  dbSecurityGroup: ec2.SecurityGroup;
}

export class DatabaseStack extends cdk.Stack {
  public readonly dbInstance: rds.DatabaseInstance;

  constructor(scope: cdk.App, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // RDS Instance
    this.dbInstance = new rds.DatabaseInstance(this, "OpenWebUIDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_13
      }),
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED
      },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL
      ),
      databaseName: 'openwebui_db',
      port: 5432,
      allocatedStorage: 20,
      securityGroups: [props.dbSecurityGroup],
      instanceIdentifier: 'openwebui-db',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Output
    new cdk.CfnOutput(this, 'DBEndpoint', {
      value: this.dbInstance.instanceEndpoint.hostname,
      description: 'RDS instance endpoint',
      exportName: 'dbEndpoint'
    });
  }
}