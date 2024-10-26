import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as rds from "aws-cdk-lib/aws-rds"
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';


export class BaselineInfrastructure extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Base VPC for the ECS cluster
    const infraVpc = new ec2.Vpc(this, "InfraVpc", {
      maxAzs: 3,
      natGateways: 1,
      vpcName: "llm-platform-vpc",
      // Define subnet configuration
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC, // for the ALB
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // for the ECS_TASKS
          cidrMask: 24,
        },
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // for the RDS
          cidrMask: 24,
        }
      ]
    });


    // Security group for RDS
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc: infraVpc,
      description: 'Security group for OpenWebUI RDS instance',
      allowAllOutbound: false,
      securityGroupName: 'openwebui-db-sg'
    });

    // Create RDS instance for OpenwebUI
    const dbInstance = new rds.DatabaseInstance(this, "OpenWebUIDatabase", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_13
      }),
      vpc: infraVpc,
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
      securityGroups: [dbSecurityGroup],
      instanceIdentifier: 'openwebui-db',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // or RETAIN for prod
    });

    // ECS Cluster with Fargate
    const ecsCluster = new ecs.Cluster(this, "EcsCluster", {
      vpc: infraVpc,
      clusterName: 'llm-platform-cluster',
      containerInsights: true,
      enableFargateCapacityProviders: true
    });

    // Security group for ECS tasks
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc: infraVpc,
      description: 'Security group for OpenWebUI ECS tasks',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-ecs-sg'
    });

    // Allow ECS tasks to connect to RDS
    dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from ECS tasks'
    );

    // Add tags for better resource management
    cdk.Tags.of(this).add('Project', 'LLMPlatform');
    cdk.Tags.of(this).add('Environment', 'Dev');

    // Output the DB endpoint for reference
    new cdk.CfnOutput(this, 'DBEndpoint', {
      value: dbInstance.instanceEndpoint.hostname,
      description: 'RDS instance endpoint',
      exportName: 'dbEndpoint'
    });
  }
}