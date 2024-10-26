import * as cdk from "aws-cdk-lib"
import * as ec2 from "aws-cdk-lib/aws-ec2"
import * as ecs from "aws-cdk-lib/aws-ecs"
import * as rds from "aws-cdk-lib/aws-rds"
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';


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

    // Create ECR repository for OpenWebUI and Bedrock Gateway Proxy
    const ecrRepository = new ecr.Repository(this, 'ecrRepository', {
      repositoryName: 'llm-platform-ecr-repo',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE
    });

    // Output the repository URI
    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR Repository URI',
      exportName: 'ecrRepositoryUri'
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

    // Create security group for internet-facing ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: infraVpc,
      description: 'Security group for ALB',
      allowAllOutbound: true,
      securityGroupName: 'openwebui-alb-sg'
    });

   // Allow inbound HTTP
   albSecurityGroup.addIngressRule(
   ec2.Peer.anyIpv4(),
   ec2.Port.tcp(80),
   'Allow HTTP traffic'
);

  // Create ALB

  // Create ALB
const alb = new elbv2.ApplicationLoadBalancer(this, 'OpenWebUIALB', {
  vpc: infraVpc,
  internetFacing: true,
  securityGroup: albSecurityGroup,
  vpcSubnets: {
    subnetType: ec2.SubnetType.PUBLIC
  }
});

// Create Target Group
const targetGroup = new elbv2.ApplicationTargetGroup(this, 'OpenWebUITargetGroup', {
  vpc: infraVpc,
  port: 8080,
  protocol: elbv2.ApplicationProtocol.HTTP,
  targetType: elbv2.TargetType.IP,
  healthCheck: {
    path: '/health',  // Verify this health check path
    healthyThresholdCount: 2,
    unhealthyThresholdCount: 3
  }
});

// Add Listener
const listener = alb.addListener('Listener', {
  port: 80,
  defaultTargetGroups: [targetGroup]
});

// Create Task Definition for OpenWebUI
const openWebUITaskDef = new ecs.FargateTaskDefinition(this, 'OpenWebUITask', {
  memoryLimitMiB: 512,
  cpu: 256,
  runtimePlatform: {
    cpuArchitecture: ecs.CpuArchitecture.ARM64,
    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
  },
});


// Add container to task definition
const openWebUIContainer = openWebUITaskDef.addContainer('OpenWebUI', {
  image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'openwebui'),
  environment: {
    'WEBUI_SECRET_KEY': 'your-secret-key',
  },
  secrets: {
    // Use individual components
    'DATABASE_URL': ecs.Secret.fromSecretsManager(
      dbInstance.secret!,
      'DATABASE_URL'
    ),
    'POSTGRES_USER': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'username'),
    'POSTGRES_PASSWORD': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'password'),
    'POSTGRES_DB': ecs.Secret.fromSecretsManager(dbInstance.secret!, 'dbname'),
  },
});

openWebUIContainer.addPortMappings({
  containerPort: 8080,
  protocol: ecs.Protocol.TCP
});

// Create ECS Cluster
const cluster = new ecs.Cluster(this, 'OpenWebUICluster', {
  vpc: infraVpc
});

// Create ECS Service
const openWebUIService = new ecs.FargateService(this, 'OpenWebUIService', {
  cluster: cluster,
  taskDefinition: openWebUITaskDef,
  desiredCount: 1,
  securityGroups: [ecsSecurityGroup],
  assignPublicIp: false,
  vpcSubnets: {
    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
  }
});

// Add to target group
openWebUIService.attachToApplicationTargetGroup(targetGroup);

// Allow traffic from ALB to ECS tasks
ecsSecurityGroup.addIngressRule(
  ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
  ec2.Port.tcp(8080),
  'Allow traffic from ALB'
);

// Output the ALB DNS name
new cdk.CfnOutput(this, 'AlbDnsName', {
  value: alb.loadBalancerDnsName,
  description: 'ALB DNS Name',
  exportName: 'albDnsName'
});
  }
}